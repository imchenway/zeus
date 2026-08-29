import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { ZeusDatabasePort } from './databasePort.js';

export const automationSchemaMigrationId = '20260829_0374_automation_tasks_v1';

export const automationStatuses = ['active', 'paused', 'deleted'] as const;
export const automationTriggerKinds = ['manual', 'once', 'interval', 'daily', 'weekly', 'rrule', 'event'] as const;
export const automationConversationModes = ['independent', 'original'] as const;
export const automationBlockStrategies = ['serial', 'discard', 'cover'] as const;
export const automationRunStatuses = ['queued', 'dispatching', 'running', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'] as const;
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
}

export interface AutomationNotificationConfig {
  success: boolean;
  failure: boolean;
  blocked: boolean;
}

export interface AutomationDefinitionSnapshot {
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
  id: string;
  automationId: string;
  automationRevisionId: string;
  projectId: string;
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
  modelSourceId: string;
  modelId: string;
  projectIds: string[];
}

export type UpdateAutomationTaskInput = Partial<CreateAutomationTaskInput> & { expectedRevision: number };

export interface EnqueueAutomationRunInput {
  id?: string;
  automationId: string;
  projectId: string;
  triggerKind: string;
  triggerIdentity: string;
  scheduledAt: string;
  causalChainId?: string;
}

interface DbAutomationTaskRow {
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
  id: string;
  automation_id: string;
  automation_revision_id: string;
  project_id: string;
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
  notification_json, next_run_at, last_triggered_at, created_at, updated_at`;

const runSelect = `id, automation_id, automation_revision_id, project_id, trigger_kind, trigger_identity, causal_chain_id, status,
  queue_position, conversation_id, submission_id, attempt, unread, may_overlap_previous, previous_run_id, scheduled_at, accepted_at,
  started_at, completed_at, error_code, error_message, created_at, updated_at`;

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

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeSnapshot(input: CreateAutomationTaskInput | (Partial<CreateAutomationTaskInput> & AutomationDefinitionSnapshot)): AutomationDefinitionSnapshot {
  const triggerKind = enumValue(input.triggerKind ?? 'manual', automationTriggerKinds, '触发方式');
  const timezone = requiredText(input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC', '时区', 128);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error('ZEUS_AUTOMATION_CONFIG_TIMEZONE_INVALID: 必须使用有效 IANA 时区。');
  }
  const conversationMode = enumValue(input.conversationMode ?? 'independent', automationConversationModes, '会话模式');
  const originalConversationId = input.originalConversationId?.trim() || null;
  if (conversationMode === 'original' && !originalConversationId) throw new Error('ZEUS_AUTOMATION_CONFIG_ORIGINAL_CONVERSATION_REQUIRED: 原会话模式必须选择会话。');
  return {
    name: requiredText(input.name, '名称', 120),
    description: (input.description ?? '').trim().slice(0, 500),
    prompt: requiredText(input.prompt, '指令', 100_000),
    triggerKind,
    triggerConfig: input.triggerConfig ?? {},
    timezone,
    conversationMode,
    originalConversationId,
    permissionMode: enumValue(input.permissionMode ?? 'read-only', automationPermissionModes, '权限模式'),
    modelSourceId: requiredText(input.modelSourceId, '模型来源', 200),
    modelId: requiredText(input.modelId, '模型', 200),
    reasoningEffort: input.reasoningEffort?.trim() || null,
    serviceTier: input.serviceTier?.trim() || null,
    fastMode: input.fastMode === true,
    skillId: input.skillId?.trim() || null,
    pluginIds: stringArray(input.pluginIds ?? [], 'Plugin'),
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

function mapTask(row: DbAutomationTaskRow): AutomationTaskRecord {
  return {
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
    id: row.id,
    automationId: row.automation_id,
    automationRevisionId: row.automation_revision_id,
    projectId: row.project_id,
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
}

export class AutomationTaskRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  create(input: CreateAutomationTaskInput): AutomationTaskRecord {
    const snapshot = normalizeSnapshot(input);
    const projectIds = stringArray(input.projectIds, '项目');
    if (projectIds.length === 0) throw new Error('ZEUS_AUTOMATION_CONFIG_PROJECT_REQUIRED: 至少选择一个项目。');
    const id = input.id ?? `automation_${nanoid(12)}`;
    const revisionId = `automation_revision_${nanoid(12)}`;
    const timestamp = nowIso();
    return this.db.transaction(() => {
      this.insertTask(id, revisionId, 0, snapshot, timestamp);
      this.insertRevision(revisionId, id, 0, snapshot, projectIds, timestamp);
      this.replaceTargets(id, projectIds, timestamp);
      return this.getById(id)!;
    });
  }

  update(id: string, input: UpdateAutomationTaskInput): AutomationTaskRecord {
    const existing = this.getById(id);
    if (!existing || existing.status === 'deleted') throw new Error('ZEUS_AUTOMATION_CONFIG_NOT_FOUND: 自动化任务不存在。');
    if (existing.revision !== input.expectedRevision) throw new Error('ZEUS_AUTOMATION_CONFIG_REVISION_CONFLICT: 配置已被更新，请刷新后重试。');
    const projectIds = input.projectIds === undefined ? this.listTargets(id).map((target) => target.projectId) : stringArray(input.projectIds, '项目');
    if (projectIds.length === 0) throw new Error('ZEUS_AUTOMATION_CONFIG_PROJECT_REQUIRED: 至少选择一个项目。');
    const snapshot = normalizeSnapshot({ ...existing, ...input, projectIds });
    const revision = existing.revision + 1;
    const revisionId = `automation_revision_${nanoid(12)}`;
    const timestamp = nowIso();
    return this.db.transaction(() => {
      this.db.execute(
        `UPDATE automation_tasks SET name = ?, description = ?, prompt = ?, current_revision_id = ?, revision = ?, trigger_kind = ?, trigger_config_json = ?, timezone = ?,
          conversation_mode = ?, original_conversation_id = ?, permission_mode = ?, model_source_id = ?, model_id = ?, reasoning_effort = ?, service_tier = ?, fast_mode = ?, skill_id = ?, plugin_ids_json = ?,
          block_strategy = ?, queue_capacity = ?, max_runs_per_day = ?, max_tokens_per_day = ?, retention_days = ?, notification_json = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
        [snapshot.name, snapshot.description, snapshot.prompt, revisionId, revision, snapshot.triggerKind, JSON.stringify(snapshot.triggerConfig), snapshot.timezone,
          snapshot.conversationMode, snapshot.originalConversationId, snapshot.permissionMode, snapshot.modelSourceId, snapshot.modelId, snapshot.reasoningEffort, snapshot.serviceTier,
          snapshot.fastMode ? 1 : 0, snapshot.skillId, JSON.stringify(snapshot.pluginIds), snapshot.blockStrategy, snapshot.queueCapacity, snapshot.maxRunsPerDay,
          snapshot.maxTokensPerDay, snapshot.retentionDays, JSON.stringify(snapshot.notifications), timestamp, id, input.expectedRevision],
      );
      if ((this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0) !== 1) throw new Error('ZEUS_AUTOMATION_CONFIG_REVISION_CONFLICT: 配置已被更新。');
      this.insertRevision(revisionId, id, revision, snapshot, projectIds, timestamp);
      this.replaceTargets(id, projectIds, timestamp);
      if (snapshot.permissionMode !== 'full-access') this.db.execute(`DELETE FROM automation_full_access_grants WHERE automation_id = ?`, [id]);
      return this.getById(id)!;
    });
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
    return this.db.select<{ automation_id: string; project_id: string; position: number; enabled: number; created_at: string }>(
      `SELECT automation_id, project_id, position, enabled, created_at FROM automation_task_targets WHERE automation_id = ? ORDER BY position, project_id`,
      [automationId],
    ).map((row) => ({ automationId: row.automation_id, projectId: row.project_id, position: row.position, enabled: row.enabled === 1, createdAt: row.created_at }));
  }

  getRevision(id: string): AutomationRevisionRecord | undefined {
    const row = this.db.get<{ id: string; automation_id: string; revision: number; snapshot_json: string; project_ids_json: string; created_at: string }>(
      `SELECT id, automation_id, revision, snapshot_json, project_ids_json, created_at FROM automation_task_revisions WHERE id = ?`, [id],
    );
    return row ? { id: row.id, automationId: row.automation_id, revision: row.revision, snapshot: parseJson<AutomationDefinitionSnapshot>(row.snapshot_json, {} as AutomationDefinitionSnapshot), projectIds: parseJson<string[]>(row.project_ids_json, []), createdAt: row.created_at } : undefined;
  }

  setStatus(id: string, status: Exclude<AutomationStatus, 'deleted'>): AutomationTaskRecord {
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
      [id, snapshot.name, snapshot.description, snapshot.prompt, revisionId, revision, snapshot.triggerKind, JSON.stringify(snapshot.triggerConfig), snapshot.timezone,
        snapshot.conversationMode, snapshot.originalConversationId, snapshot.permissionMode, snapshot.modelSourceId, snapshot.modelId, snapshot.reasoningEffort,
        snapshot.serviceTier, snapshot.fastMode ? 1 : 0, snapshot.skillId, JSON.stringify(snapshot.pluginIds), snapshot.blockStrategy, snapshot.queueCapacity,
        snapshot.maxRunsPerDay, snapshot.maxTokensPerDay, snapshot.retentionDays, JSON.stringify(snapshot.notifications), timestamp, timestamp],
    );
  }

  private insertRevision(id: string, automationId: string, revision: number, snapshot: AutomationDefinitionSnapshot, projectIds: string[], timestamp: string): void {
    this.db.execute(`INSERT INTO automation_task_revisions (id, automation_id, revision, snapshot_json, project_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [id, automationId, revision, JSON.stringify(snapshot), JSON.stringify(projectIds), timestamp]);
  }

  private replaceTargets(automationId: string, projectIds: string[], timestamp: string): void {
    this.db.execute(`DELETE FROM automation_task_targets WHERE automation_id = ?`, [automationId]);
    projectIds.forEach((projectId, position) => this.db.execute(`INSERT INTO automation_task_targets (automation_id, project_id, position, enabled, created_at) VALUES (?, ?, ?, 1, ?)`, [automationId, projectId, position, timestamp]));
  }
}

export class AutomationRunRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  enqueue(input: EnqueueAutomationRunInput): AutomationRunRecord {
    const task = new AutomationTaskRepository(this.db).getById(input.automationId);
    if (!task || task.status !== 'active') throw new Error('ZEUS_AUTOMATION_TRIGGER_INACTIVE: 自动化任务未启用。');
    const timestamp = nowIso();
    const existing = this.db.get<DbAutomationRunRow>(`SELECT ${runSelect} FROM automation_runs WHERE automation_id = ? AND project_id = ? AND trigger_identity = ?`, [input.automationId, input.projectId, input.triggerIdentity]);
    if (existing) return mapRun(existing);
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
      const active = this.listActive(task.id, input.projectId);
      if (task.blockStrategy === 'discard' && active.length > 0) return this.insertTerminal(input, task, 'cancelled', 'ZEUS_AUTOMATION_QUEUE_DISCARDED', '已按阻塞策略丢弃本次触发。', timestamp);
      let previousRunId: string | null = null;
      let mayOverlap = false;
      if (task.blockStrategy === 'cover' && active.length > 0) {
        const previous = active[0]!;
        previousRunId = previous.id;
        mayOverlap = previous.status === 'dispatching' || previous.status === 'running';
        this.setTerminal(previous.id, 'outcome_unknown', 'ZEUS_AUTOMATION_DISPATCH_OUTCOME_UNKNOWN', '覆盖时无法证明旧 Provider 或外部命令已停止。');
      }
      const queued = this.db.select<{ id: string }>(`SELECT id FROM automation_runs WHERE automation_id = ? AND project_id = ? AND status = 'queued' ORDER BY accepted_at, id`, [task.id, input.projectId]);
      if (task.blockStrategy === 'serial' && active.length > 0 && queued.length >= task.queueCapacity) {
        this.setTerminal(queued[0]!.id, 'cancelled', 'ZEUS_AUTOMATION_QUEUE_EVICTED', '队列已满，已淘汰最早等待运行。');
      }
      const id = input.id ?? `automation_run_${nanoid(12)}`;
      const causalChainId = input.causalChainId ?? `automation_chain_${nanoid(12)}`;
      const queuePosition = task.blockStrategy === 'serial' && active.length > 0 ? queued.length + 1 : 0;
      this.db.execute(
        `INSERT INTO automation_runs (id, automation_id, automation_revision_id, project_id, trigger_kind, trigger_identity, causal_chain_id,
          status, queue_position, attempt, unread, may_overlap_previous, previous_run_id, scheduled_at, accepted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
        [id, task.id, task.currentRevisionId, input.projectId, input.triggerKind, input.triggerIdentity, causalChainId, queuePosition, mayOverlap ? 1 : 0, previousRunId, input.scheduledAt, timestamp, timestamp, timestamp],
      );
      this.db.execute(`INSERT OR IGNORE INTO automation_trigger_receipts (automation_id, project_id, trigger_identity, run_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [task.id, input.projectId, input.triggerIdentity, id, input.scheduledAt, timestamp]);
      try {
        this.db.execute(`INSERT INTO automation_causal_chain_members (causal_chain_id, automation_id, project_id, run_id, created_at) VALUES (?, ?, ?, ?, ?)`, [causalChainId, task.id, input.projectId, id, timestamp]);
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

  listInbox(input: { unreadOnly?: boolean; status?: AutomationRunStatus; limit?: number } = {}): AutomationRunRecord[] {
    const clauses = [`status IN ('succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown')`];
    const params: Array<string | number> = [];
    if (input.unreadOnly) clauses.push('unread = 1');
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    params.push(Math.max(1, Math.min(Math.trunc(input.limit ?? 100), 500)));
    return this.db.select<DbAutomationRunRow>(`SELECT ${runSelect} FROM automation_runs WHERE ${clauses.join(' AND ')} ORDER BY completed_at DESC, created_at DESC LIMIT ?`, params).map(mapRun);
  }

  listDispatchable(limit = 10): AutomationRunRecord[] {
    return this.db.select<DbAutomationRunRow>(
      `SELECT ${runSelect} FROM automation_runs r WHERE r.status = 'queued' AND COALESCE(r.queue_position, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM automation_runs active WHERE active.automation_id = r.automation_id AND active.project_id = r.project_id
         AND active.id <> r.id AND active.status IN ('dispatching', 'running')) ORDER BY r.accepted_at, r.id LIMIT ?`,
      [Math.max(1, Math.min(Math.trunc(limit), 100))],
    ).map(mapRun);
  }

  listActive(automationId: string, projectId: string): AutomationRunRecord[] {
    return this.db.select<DbAutomationRunRow>(`SELECT ${runSelect} FROM automation_runs WHERE automation_id = ? AND project_id = ? AND status IN ('dispatching', 'running') ORDER BY accepted_at, id`, [automationId, projectId]).map(mapRun);
  }

  markDispatching(id: string): AutomationRunRecord {
    const timestamp = nowIso();
    const current = this.getById(id);
    if (!current || current.status !== 'queued') throw new Error('ZEUS_AUTOMATION_DISPATCH_NOT_QUEUED: 运行已不在等待队列。');
    const attempt = current.attempt + 1;
    this.db.transaction(() => {
      this.db.execute(`UPDATE automation_runs SET status = 'dispatching', attempt = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'`, [attempt, timestamp, timestamp, id]);
      this.db.execute(`INSERT INTO automation_run_attempts (id, run_id, attempt, status, operation_identity, started_at) VALUES (?, ?, ?, 'dispatching', ?, ?)`, [`automation_attempt_${nanoid(12)}`, id, attempt, `automation-dispatch:${id}:${attempt}`, timestamp]);
    });
    return this.getById(id)!;
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

  setTerminal(id: string, status: Extract<AutomationRunStatus, 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown'>, errorCode: string | null = null, errorMessage: string | null = null): AutomationRunRecord {
    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db.execute(`UPDATE automation_runs SET status = ?, unread = 1, completed_at = COALESCE(completed_at, ?), error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`, [status, timestamp, errorCode, errorMessage, timestamp, id]);
      this.db.execute(`UPDATE automation_run_attempts SET status = ?, completed_at = COALESCE(completed_at, ?), error_code = ?, error_message = ? WHERE run_id = ? AND attempt = (SELECT attempt FROM automation_runs WHERE id = ?)`, [status, timestamp, errorCode, errorMessage, id, id]);
      const task = this.db.get<{ notification_json: string }>(`SELECT notification_json FROM automation_tasks WHERE id = (SELECT automation_id FROM automation_runs WHERE id = ?)`, [id]);
      const notifications = parseJson<AutomationNotificationConfig>(task?.notification_json ?? '{}', { success: true, failure: true, blocked: true });
      const notificationEnabled = status === 'succeeded' ? notifications.success : status === 'blocked' || status === 'outcome_unknown' ? notifications.blocked : notifications.failure;
      if (notificationEnabled) {
        this.db.execute(
          `INSERT OR IGNORE INTO automation_notification_outbox (id, run_id, kind, payload_json, status, attempt, available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
          [`automation_notification_${nanoid(12)}`, id, status, JSON.stringify({ runId: id, status }), timestamp, timestamp, timestamp],
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
    const id = input.id ?? `automation_run_${nanoid(12)}`;
    const causalChainId = input.causalChainId ?? `automation_chain_${nanoid(12)}`;
    this.db.execute(
      `INSERT INTO automation_runs (id, automation_id, automation_revision_id, project_id, trigger_kind, trigger_identity, causal_chain_id, status,
       attempt, unread, scheduled_at, accepted_at, completed_at, error_code, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?)`,
      [id, task.id, task.currentRevisionId, input.projectId, input.triggerKind, input.triggerIdentity, causalChainId, status, input.scheduledAt, timestamp, timestamp, errorCode, errorMessage, timestamp, timestamp],
    );
    this.db.execute(`INSERT OR IGNORE INTO automation_trigger_receipts (automation_id, project_id, trigger_identity, run_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [task.id, input.projectId, input.triggerIdentity, id, input.scheduledAt, timestamp]);
    return this.getById(id)!;
  }

  private promoteNext(completedId: string): void {
    const completed = this.getById(completedId);
    if (!completed) return;
    const next = this.db.get<{ id: string }>(`SELECT id FROM automation_runs WHERE automation_id = ? AND project_id = ? AND status = 'queued' ORDER BY accepted_at, id LIMIT 1`, [completed.automationId, completed.projectId]);
    if (!next) return;
    this.db.execute(`UPDATE automation_runs SET queue_position = 0 WHERE id = ?`, [next.id]);
    this.db.execute(`UPDATE automation_runs SET queue_position = queue_position - 1 WHERE automation_id = ? AND project_id = ? AND status = 'queued' AND queue_position > 0 AND id <> ?`, [completed.automationId, completed.projectId, next.id]);
  }
}
