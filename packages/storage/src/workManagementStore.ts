import { nanoid } from 'nanoid';
import {
  createDefaultTaskBoardViewSettings,
  isTaskManagementStatus,
  isTaskType,
  normalizeTaskBoardViewSettings,
  type TaskAttachmentReference,
  type TaskBoardLaneIdentity,
  type TaskBoardPosition,
  type TaskBoardViewSettings,
  type TaskBoardViewSnapshot,
  type TaskManagementStatus,
  type TaskPriority,
  type TaskType,
} from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';
import { canonicalJson, shouldAcceptProviderSnapshot, validateMcpStartupStatusSnapshot, validateRateLimitsSnapshot, type CodexMcpStartupStatusSnapshot, type CodexRateLimitsSnapshot } from './conversationStore.js';

export { isTaskManagementStatus, isTaskPriority, isTaskType } from '@zeus/shared';
export type { TaskManagementStatus, TaskPriority, TaskType } from '@zeus/shared';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertEnum<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value as T[number])) throw new Error(`Invalid ${label}: ${String(value)}`);
  return value as T[number];
}

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

/** 项目容器内由用户确认纳入的真实 Git 仓库。 */
export interface ZeusProjectRepositoryRecord {
  id: string;
  projectId: string;
  name: string;
  relativePath: string;
  localPath: string;
  createdAt: string;
  updatedAt: string;
}

/** 项目容器内允许任务直接持久写入的非 Git 目录。 */
export interface ZeusProjectSharedPathRecord {
  id: string;
  projectId: string;
  relativePath: string;
  localPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ZeusTaskRecord {
  id: string;
  projectId: string;
  taskCode: string;
  taskSequence: number | null;
  parentTaskId: string | null;
  relatedTaskIds: string[];
  title: string;
  taskType: TaskType;
  description: string;
  defectCurrentState: string;
  defectExpectedOutcome: string;
  defectReproductionSteps: string;
  optimizationCurrentState: string;
  optimizationExpectedOutcome: string;
  managementStatus: TaskManagementStatus;
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

export type TaskWorkspaceState = 'ready' | 'reclaimed' | 'merged' | 'discarded' | 'failed';
export type TaskWorkspaceKind = 'task' | 'conflict';
export type TaskEnvironmentState = 'ready' | 'reclaimed' | 'failed';

/** 一次任务推送的内部聚合记录，用于关联多个仓库工作区。 */
export interface ZeusTaskEnvironmentRecord {
  id: string;
  projectId: string;
  taskId: string;
  rootPath: string | null;
  state: TaskEnvironmentState;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 任务工作区代表一次任务推送创建的独立任务开发线。
 * 会话结束不会删除工作区；只有任务完成、取消或显式清理才会回收 worktree。
 */
export interface ZeusTaskWorkspaceRecord {
  id: string;
  projectId: string;
  taskId: string;
  kind: TaskWorkspaceKind;
  baseWorkspaceId: string | null;
  environmentId: string | null;
  repositoryId: string | null;
  repositoryName: string;
  repositoryRelativePath: string;
  repositoryPath: string;
  branchName: string;
  sourceBranch: string;
  sourceHeadSha: string;
  remoteName: string;
  remoteBranch: string;
  worktreePath: string | null;
  headSha: string | null;
  state: TaskWorkspaceState;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskWorkspaceInput {
  id?: string;
  projectId: string;
  taskId: string;
  kind?: TaskWorkspaceKind;
  baseWorkspaceId?: string;
  environmentId?: string;
  repositoryId?: string;
  repositoryName?: string;
  repositoryRelativePath?: string;
  repositoryPath?: string;
  branchName: string;
  sourceBranch: string;
  sourceHeadSha: string;
  remoteName?: string;
  remoteBranch?: string;
  worktreePath?: string;
  headSha?: string;
  state?: TaskWorkspaceState;
}

export interface UpdateTaskWorkspaceInput {
  worktreePath?: string | null;
  headSha?: string | null;
  state?: TaskWorkspaceState;
  remoteBranch?: string;
  lastError?: string | null;
}

export interface CreateProjectRepositoryInput {
  id?: string;
  projectId: string;
  name: string;
  relativePath: string;
  localPath: string;
}

export interface CreateProjectSharedPathInput {
  id?: string;
  projectId: string;
  relativePath: string;
  localPath: string;
}

export interface CreateTaskEnvironmentInput {
  id?: string;
  projectId: string;
  taskId: string;
  rootPath?: string;
  state?: TaskEnvironmentState;
}

export interface UpdateTaskEnvironmentInput {
  rootPath?: string | null;
  state?: TaskEnvironmentState;
  lastError?: string | null;
}

export type TaskIntegrationMode = 'merge' | 'squash';
export type TaskIntegrationState = 'preparing' | 'conflicted' | 'pending_local_sync' | 'merged' | 'failed';
export type TaskIntegrationLocalSyncStatus = 'synced' | 'pending';
export type TaskIntegrationAttemptState = 'preparing' | 'active' | 'completed' | 'failed' | 'stale';

export interface ZeusTaskIntegrationRecord {
  id: string;
  projectId: string;
  taskId: string;
  workspaceId: string;
  targetBranch: string;
  targetHeadSha: string;
  taskHeadSha: string | null;
  mode: TaskIntegrationMode;
  integrationPath: string | null;
  resultHeadSha: string | null;
  state: TaskIntegrationState;
  localSyncStatus: TaskIntegrationLocalSyncStatus | null;
  localHeadSha: string | null;
  localWorktreePath: string | null;
  conflictFiles: string[];
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskIntegrationInput {
  id?: string;
  projectId: string;
  taskId: string;
  workspaceId: string;
  targetBranch: string;
  targetHeadSha: string;
  taskHeadSha: string;
  mode: TaskIntegrationMode;
  integrationPath?: string;
  state?: TaskIntegrationState;
}

export interface UpdateTaskIntegrationInput {
  integrationPath?: string | null;
  resultHeadSha?: string | null;
  state?: TaskIntegrationState;
  localSyncStatus?: TaskIntegrationLocalSyncStatus | null;
  localHeadSha?: string | null;
  localWorktreePath?: string | null;
  conflictFiles?: string[];
  lastError?: string | null;
}

export interface ZeusTaskIntegrationAttemptRecord {
  id: string;
  integrationId: string;
  conversationId: string;
  submissionId: string;
  worktreePath: string;
  targetHeadSha: string;
  taskHeadSha: string;
  state: TaskIntegrationAttemptState;
  resultHeadSha: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskIntegrationAttemptInput {
  id: string;
  integrationId: string;
  conversationId: string;
  submissionId: string;
  worktreePath: string;
  targetHeadSha: string;
  taskHeadSha: string;
  state?: TaskIntegrationAttemptState;
}

export interface UpdateTaskIntegrationAttemptInput {
  worktreePath?: string;
  targetHeadSha?: string;
  taskHeadSha?: string;
  state?: TaskIntegrationAttemptState;
  resultHeadSha?: string | null;
  lastError?: string | null;
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
  id?: string;
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
  id?: string;
  projectId: string;
  parentTaskId?: string | null;
  title: string;
  taskType: TaskType;
  description: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  createdFrom: string;
  sourceContext: Record<string, unknown>;
  managementStatus?: TaskManagementStatus;
  priority?: TaskPriority;
  templateId?: string;
  tags?: string[];
  allowCodeChanges?: boolean;
  allowTests?: boolean;
  allowGitCommit?: boolean;
}

export interface UpdateTaskRelationshipsInput {
  expectedUpdatedAt: string;
  parentTaskId?: string | null;
  relatedTaskIds?: string[];
}

export interface DeleteTaskInput {
  childStrategy?: 'reparent' | 'delete_descendants' | 'make_roots';
  replacementParentTaskId?: string;
}

export interface DeleteTaskResult {
  task: ZeusTaskRecord;
  deletedTaskIds: string[];
  movedChildTaskIds: string[];
}

export interface CreateTaskTemplateInput {
  id?: string;
  projectId?: string;
  name: string;
  description: string;
  promptTemplate: string;
  category?: string;
  defaultOptions?: Record<string, unknown>;
}

export interface CreateTaskFromTemplateInput {
  id?: string;
  projectId: string;
  template: ZeusTaskTemplateRecord;
  managementStatus?: TaskManagementStatus;
  title?: string;
  variables?: Record<string, string>;
}

export interface TaskListOptions {
  query?: string;
  status?: ZeusTaskRecord['status'];
  managementStatus?: TaskManagementStatus;
  tag?: string;
  sortBy?: 'createdAt' | 'updatedAt' | 'title' | 'taskType' | 'status' | 'managementStatus';
  sortDirection?: 'asc' | 'desc';
}

export interface UpdateTaskInput {
  title?: string;
  taskType?: TaskType;
  description?: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  allowCodeChanges?: boolean;
  allowTests?: boolean;
  allowGitCommit?: boolean;
}

export type TaskEditableField =
  | 'title'
  | 'taskType'
  | 'description'
  | 'defectCurrentState'
  | 'defectExpectedOutcome'
  | 'defectReproductionSteps'
  | 'optimizationCurrentState'
  | 'optimizationExpectedOutcome'
  | 'priority'
  | 'tags'
  | 'attachments'
  | 'sourceContext'
  | 'allowCodeChanges'
  | 'allowTests'
  | 'allowGitCommit';

export interface UpdateTaskContentInput extends UpdateTaskInput {
  expectedUpdatedAt: string;
  priority?: TaskPriority;
  tags?: string[];
  attachments?: TaskAttachmentReference[];
  sourceContext?: Record<string, unknown>;
}

export interface UpdateTaskContentResult {
  task: ZeusTaskRecord;
  changedFields: TaskEditableField[];
  tagCountBefore: number;
  tagCountAfter: number;
  attachmentCountBefore: number;
  attachmentCountAfter: number;
  previousUpdatedAt: string;
}

export interface ZeusTaskEventRecord {
  id: string;
  taskId: string;
  eventType: string;
  title: string;
  payloadJson: string;
  createdAt: string;
}

export interface CreateTaskEventInput {
  taskId: string;
  eventType: string;
  title: string;
  payload: Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextIsoTimestamp(previousTimestamp: string): string {
  const now = Date.now();
  const previous = Date.parse(previousTimestamp);
  return new Date(Number.isFinite(previous) ? Math.max(now, previous + 1) : now).toISOString();
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
  return `ZEUS-${String(sequence).padStart(4, '0')}`;
}

function normalizeTaskSequence(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeTaskCode(value: unknown, sequence: number | null): string {
  if (typeof value === 'string') {
    const code = value.trim();
    // 只保留至少四位的统一格式；旧库编码由回填逻辑按原序号重新格式化。
    if (/^ZEUS-\d{4,}$/u.test(code)) return code;
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

function parseTaskSourceContextJson(sourceContextJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(sourceContextJson) as unknown;
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function countTaskAttachmentReferences(sourceContext: Record<string, unknown>): number {
  return Array.isArray(sourceContext.attachments) ? sourceContext.attachments.length : 0;
}

function throwTaskEditConflict(taskId: string, currentUpdatedAt: string): never {
  throw Object.assign(new Error(`Zeus task changed after editing started: ${taskId}`), {
    code: 'ZEUS_TASK_EDIT_CONFLICT' as const,
    currentUpdatedAt,
  });
}

function filterAndSortTasks(records: ZeusTaskRecord[], options: TaskListOptions): ZeusTaskRecord[] {
  const query = options.query?.trim().toLowerCase();
  const tag = options.tag?.trim();
  const filtered = records.filter((record) => {
    const matchesQuery =
      !query ||
      [
        record.taskCode,
        record.id,
        record.title,
        record.taskType,
        record.description,
        record.defectCurrentState,
        record.defectExpectedOutcome,
        record.defectReproductionSteps,
        record.optimizationCurrentState,
        record.optimizationExpectedOutcome,
        record.createdFrom,
        record.sourceContextJson,
        record.priority,
      ]
        .join('\n')
        .toLowerCase()
        .includes(query);
    const matchesStatus = !options.status || record.status === options.status;
    const matchesManagementStatus = !options.managementStatus || record.managementStatus === options.managementStatus;
    const matchesTag = !tag || record.tags.includes(tag);
    return matchesQuery && matchesStatus && matchesManagementStatus && matchesTag;
  });
  const sortBy = options.sortBy ?? 'createdAt';
  const direction = options.sortDirection === 'desc' ? -1 : 1;
  return [...filtered].sort((left, right) => {
    const leftValue = String(left[sortBy]);
    const rightValue = String(right[sortBy]);
    return leftValue.localeCompare(rightValue) * direction;
  });
}

export class SettingRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

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
  constructor(private readonly db: ZeusDatabasePort) {}

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
      id: input.id ?? `project_${nanoid(12)}`,
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
    // 只有真实修改本地路径时才执行唯一性校验；显示名称等元数据更新不应被历史重复路径数据阻断。
    if (input.localPath !== undefined && localPath !== existing.localPath) {
      const duplicated = this.findByLocalPath(localPath, projectId);
      if (duplicated) {
        throw new Error(`Zeus project localPath already exists: ${localPath}`);
      }
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

const selectTaskFields = `id, project_id, task_code, task_sequence, parent_task_id, title, task_type, description,
  defect_current_state, defect_expected_outcome, defect_reproduction_steps, optimization_current_state, optimization_expected_outcome,
  management_status, status, priority, tags_json, template_id,
  allow_code_changes, allow_tests, allow_git_commit, created_from, source_context_json, created_at, updated_at`;

/** 任务仓储保存真实任务定义，初始状态统一为 ready，等待用户或 runtime 执行。 */
export class TaskRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  private nextTaskSequence(projectId: string): number {
    // 任务编码按项目内未删除任务的最大序号递增，保持与当前列表/回填口径一致。
    const row = this.db.get<{ sequence: number | null }>(`SELECT MAX(task_sequence) AS sequence FROM tasks WHERE project_id = ? AND deleted_at IS NULL`, [projectId]);
    return (row?.sequence ?? 0) + 1;
  }

  create(input: CreateTaskInput): ZeusTaskRecord {
    return this.db.transaction(() => {
      const timestamp = nowIso();
      const taskSequence = this.nextTaskSequence(input.projectId);
      const parentTaskId = input.parentTaskId ?? null;
      if (parentTaskId) this.assertValidParent(input.projectId, '__new_task__', parentTaskId, 1);
      const record: ZeusTaskRecord = {
        id: input.id ?? `task_${nanoid(12)}`,
        projectId: input.projectId,
        taskCode: formatTaskCode(taskSequence),
        taskSequence,
        parentTaskId,
        relatedTaskIds: [],
        title: input.title,
        taskType: input.taskType,
        description: input.description,
        defectCurrentState: input.defectCurrentState ?? '',
        defectExpectedOutcome: input.defectExpectedOutcome ?? '',
        defectReproductionSteps: input.defectReproductionSteps ?? '',
        optimizationCurrentState: input.optimizationCurrentState ?? '',
        optimizationExpectedOutcome: input.optimizationExpectedOutcome ?? '',
        managementStatus: isTaskManagementStatus(input.managementStatus) ? input.managementStatus : 'todo',
        status: 'ready',
        priority: input.priority ?? 'p3',
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
        `INSERT INTO tasks (id, project_id, task_code, task_sequence, parent_task_id, title, task_type, description,
        defect_current_state, defect_expected_outcome, defect_reproduction_steps, optimization_current_state, optimization_expected_outcome,
        management_status, status, priority, tags_json, template_id,
        allow_code_changes, allow_tests, allow_git_commit, created_from, source_context_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.projectId,
          record.taskCode,
          record.taskSequence,
          record.parentTaskId,
          record.title,
          record.taskType,
          record.description,
          record.defectCurrentState,
          record.defectExpectedOutcome,
          record.defectReproductionSteps,
          record.optimizationCurrentState,
          record.optimizationExpectedOutcome,
          record.managementStatus,
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
    });
  }

  createFromTemplate(input: CreateTaskFromTemplateInput): ZeusTaskRecord {
    const variables = input.variables ?? {};
    const description = renderPromptTemplate(input.template.promptTemplate, variables);
    return this.create({
      ...(input.id ? { id: input.id } : {}),
      projectId: input.projectId,
      title: input.title ?? input.template.name,
      taskType: 'requirement',
      description,
      managementStatus: input.managementStatus,
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
    return row ? this.withRelatedTaskIds(mapTaskRow(row)) : undefined;
  }

  archive(taskId: string): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) throw new Error(`Zeus task not found: ${taskId}`);
    const timestamp = nextIsoTimestamp(existing.updatedAt);
    this.db.execute(`UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, taskId]);
    const archived = this.getById(taskId);
    if (!archived) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return archived;
  }

  restore(taskId: string): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) throw new Error(`Zeus task not found: ${taskId}`);
    const timestamp = nextIsoTimestamp(existing.updatedAt);
    // 恢复只切换归档标记，保留任务状态与时间线来源，避免丢失真实执行上下文。
    this.db.execute(`UPDATE tasks SET archived = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, taskId]);
    const restored = this.getById(taskId);
    if (!restored) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return restored;
  }

  updateStatus(taskId: string, status: ZeusTaskRecord['status']): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) throw new Error(`Zeus task not found: ${taskId}`);
    const timestamp = nextIsoTimestamp(existing.updatedAt);
    this.db.execute(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [status, timestamp, taskId]);
    const updated = this.getById(taskId);
    if (!updated) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return updated;
  }

  updateManagementStatus(taskId: string, managementStatus: TaskManagementStatus, expectedUpdatedAt?: string): ZeusTaskRecord {
    if (!isTaskManagementStatus(managementStatus)) throw new Error(`Unknown Zeus task management status: ${String(managementStatus)}`);
    const existing = this.getById(taskId);
    if (!existing) throw new Error(`Zeus task not found: ${taskId}`);
    if (expectedUpdatedAt && existing.updatedAt !== expectedUpdatedAt) throwTaskEditConflict(taskId, existing.updatedAt);
    if (existing.managementStatus === managementStatus) return existing;
    const timestamp = nextIsoTimestamp(existing.updatedAt);
    this.db.execute(`UPDATE tasks SET management_status = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`, [managementStatus, timestamp, taskId, expectedUpdatedAt ?? existing.updatedAt]);
    const modifiedRows = this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0;
    if (modifiedRows !== 1) {
      const current = this.getById(taskId);
      throwTaskEditConflict(taskId, current?.updatedAt ?? existing.updatedAt);
    }
    const updated = this.getById(taskId);
    if (!updated) throw new Error(`Zeus task not found: ${taskId}`);
    return updated;
  }

  replaceManagementStatusForProject(projectId: string, fromStatus: TaskManagementStatus, toStatus: TaskManagementStatus): ZeusTaskRecord[] {
    if (!isTaskManagementStatus(fromStatus) || !isTaskManagementStatus(toStatus)) throw new Error('Unknown Zeus task management status replacement.');
    if (fromStatus === toStatus) return [];
    return this.db.transaction(() => {
      const taskIds = this.db.select<{ id: string }>(`SELECT id FROM tasks WHERE project_id = ? AND management_status = ? AND deleted_at IS NULL ORDER BY created_at ASC`, [projectId, fromStatus]).map((row) => row.id);
      return taskIds.map((taskId) => this.updateManagementStatus(taskId, toStatus));
    });
  }

  update(taskId: string, input: UpdateTaskInput): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    const timestamp = nextIsoTimestamp(existing.updatedAt);
    this.db.execute(
      `UPDATE tasks SET title = ?, task_type = ?, description = ?, defect_current_state = ?, defect_expected_outcome = ?, defect_reproduction_steps = ?, optimization_current_state = ?, optimization_expected_outcome = ?, allow_code_changes = ?, allow_tests = ?, allow_git_commit = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
      [
        input.title ?? existing.title,
        input.taskType ?? existing.taskType,
        input.description ?? existing.description,
        input.defectCurrentState ?? existing.defectCurrentState,
        input.defectExpectedOutcome ?? existing.defectExpectedOutcome,
        input.defectReproductionSteps ?? existing.defectReproductionSteps,
        input.optimizationCurrentState ?? existing.optimizationCurrentState,
        input.optimizationExpectedOutcome ?? existing.optimizationExpectedOutcome,
        (input.allowCodeChanges ?? existing.allowCodeChanges) ? 1 : 0,
        (input.allowTests ?? existing.allowTests) ? 1 : 0,
        (input.allowGitCommit ?? existing.allowGitCommit) ? 1 : 0,
        timestamp,
        taskId,
      ],
    );
    const updated = this.getById(taskId);
    if (!updated) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return updated;
  }

  updateContent(taskId: string, input: UpdateTaskContentInput): UpdateTaskContentResult {
    return this.db.transaction(() => {
      const existing = this.getById(taskId);
      if (!existing) {
        throw new Error(`Zeus task not found: ${taskId}`);
      }
      if (existing.updatedAt !== input.expectedUpdatedAt) {
        throwTaskEditConflict(taskId, existing.updatedAt);
      }

      const title = input.title === undefined ? existing.title : input.title.trim();
      if (!title) {
        throw Object.assign(new Error('Task title is required.'), { code: 'ZEUS_TASK_TITLE_REQUIRED' as const });
      }
      const taskType = input.taskType ?? existing.taskType;
      if (!isTaskType(taskType)) {
        throw Object.assign(new Error('Task type is required.'), { code: 'ZEUS_INVALID_TASK_TYPE' as const });
      }
      const description = input.description ?? existing.description;
      const defectCurrentState = input.defectCurrentState ?? existing.defectCurrentState;
      const defectExpectedOutcome = input.defectExpectedOutcome ?? existing.defectExpectedOutcome;
      const defectReproductionSteps = input.defectReproductionSteps ?? existing.defectReproductionSteps;
      const optimizationCurrentState = input.optimizationCurrentState ?? existing.optimizationCurrentState;
      const optimizationExpectedOutcome = input.optimizationExpectedOutcome ?? existing.optimizationExpectedOutcome;
      const priority = input.priority ?? existing.priority;
      const tags = input.tags === undefined ? existing.tags : normalizeTags(input.tags);
      const allowCodeChanges = input.allowCodeChanges ?? existing.allowCodeChanges;
      const allowTests = input.allowTests ?? existing.allowTests;
      const allowGitCommit = input.allowGitCommit ?? existing.allowGitCommit;
      const previousSourceContext = parseTaskSourceContextJson(existing.sourceContextJson);
      const sourceContext = input.sourceContext ? { ...input.sourceContext } : input.attachments ? { ...previousSourceContext, attachments: input.attachments } : previousSourceContext;
      const sourceContextJson = JSON.stringify(sourceContext);
      const changedFields: TaskEditableField[] = [];
      if (title !== existing.title) changedFields.push('title');
      if (taskType !== existing.taskType) changedFields.push('taskType');
      if (description !== existing.description) changedFields.push('description');
      if (defectCurrentState !== existing.defectCurrentState) changedFields.push('defectCurrentState');
      if (defectExpectedOutcome !== existing.defectExpectedOutcome) changedFields.push('defectExpectedOutcome');
      if (defectReproductionSteps !== existing.defectReproductionSteps) changedFields.push('defectReproductionSteps');
      if (optimizationCurrentState !== existing.optimizationCurrentState) changedFields.push('optimizationCurrentState');
      if (optimizationExpectedOutcome !== existing.optimizationExpectedOutcome) changedFields.push('optimizationExpectedOutcome');
      if (priority !== existing.priority) changedFields.push('priority');
      if (canonicalJson(tags) !== canonicalJson(existing.tags)) changedFields.push('tags');
      if (input.attachments !== undefined && canonicalJson(sourceContext.attachments) !== canonicalJson(previousSourceContext.attachments)) changedFields.push('attachments');
      else if (input.sourceContext !== undefined && canonicalJson(sourceContext) !== canonicalJson(previousSourceContext)) changedFields.push('sourceContext');
      if (allowCodeChanges !== existing.allowCodeChanges) changedFields.push('allowCodeChanges');
      if (allowTests !== existing.allowTests) changedFields.push('allowTests');
      if (allowGitCommit !== existing.allowGitCommit) changedFields.push('allowGitCommit');

      const resultBase = {
        tagCountBefore: existing.tags.length,
        tagCountAfter: tags.length,
        attachmentCountBefore: countTaskAttachmentReferences(previousSourceContext),
        attachmentCountAfter: countTaskAttachmentReferences(sourceContext),
        previousUpdatedAt: existing.updatedAt,
      };
      if (changedFields.length === 0) {
        return { task: existing, changedFields, ...resultBase };
      }

      const timestamp = nextIsoTimestamp(existing.updatedAt);
      this.db.execute(
        `UPDATE tasks
         SET title = ?, task_type = ?, description = ?, defect_current_state = ?, defect_expected_outcome = ?, defect_reproduction_steps = ?,
             optimization_current_state = ?, optimization_expected_outcome = ?, priority = ?, tags_json = ?, source_context_json = ?,
             allow_code_changes = ?, allow_tests = ?, allow_git_commit = ?, updated_at = ?
         WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
        [
          title,
          taskType,
          description,
          defectCurrentState,
          defectExpectedOutcome,
          defectReproductionSteps,
          optimizationCurrentState,
          optimizationExpectedOutcome,
          priority,
          JSON.stringify(tags),
          sourceContextJson,
          allowCodeChanges ? 1 : 0,
          allowTests ? 1 : 0,
          allowGitCommit ? 1 : 0,
          timestamp,
          taskId,
          input.expectedUpdatedAt,
        ],
      );
      const modifiedRows = this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0;
      if (modifiedRows !== 1) {
        const current = this.getById(taskId);
        throwTaskEditConflict(taskId, current?.updatedAt ?? existing.updatedAt);
      }
      const updated = this.getById(taskId);
      if (!updated) {
        throw new Error(`Zeus task not found after update: ${taskId}`);
      }
      return { task: updated, changedFields, ...resultBase };
    });
  }

  updateSourceContext(taskId: string, sourceContext: Record<string, unknown>): ZeusTaskRecord {
    const existing = this.getById(taskId);
    if (!existing) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    const timestamp = nextIsoTimestamp(existing.updatedAt);
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
    const timestamp = nextIsoTimestamp(existing.updatedAt);
    this.db.execute(`UPDATE tasks SET tags_json = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [JSON.stringify(normalizeTags(tags)), timestamp, taskId]);
    const updated = this.getById(taskId);
    if (!updated) {
      throw new Error(`Zeus task not found: ${taskId}`);
    }
    return updated;
  }

  updateRelationships(taskId: string, input: UpdateTaskRelationshipsInput): ZeusTaskRecord {
    return this.db.transaction(() => {
      const existing = this.getById(taskId);
      if (!existing) throw new Error(`Zeus task not found: ${taskId}`);
      if (existing.updatedAt !== input.expectedUpdatedAt) throwTaskEditConflict(taskId, existing.updatedAt);
      const parentTaskId = input.parentTaskId === undefined ? existing.parentTaskId : input.parentTaskId;
      const relatedTaskIds = input.relatedTaskIds === undefined ? existing.relatedTaskIds : [...new Set(input.relatedTaskIds)];
      this.assertValidParent(existing.projectId, taskId, parentTaskId, this.subtreeHeight(taskId));
      this.assertValidRelatedTasks(existing, relatedTaskIds);
      if (parentTaskId === existing.parentTaskId && canonicalJson(relatedTaskIds.slice().sort()) === canonicalJson(existing.relatedTaskIds.slice().sort())) return existing;
      const timestamp = nextIsoTimestamp(existing.updatedAt);
      this.db.execute(`UPDATE tasks SET parent_task_id = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`, [parentTaskId, timestamp, taskId, input.expectedUpdatedAt]);
      const modifiedRows = this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0;
      if (modifiedRows !== 1) throwTaskEditConflict(taskId, this.getById(taskId)?.updatedAt ?? existing.updatedAt);
      if (input.relatedTaskIds !== undefined) {
        this.db.execute(`DELETE FROM task_relations WHERE left_task_id = ? OR right_task_id = ?`, [taskId, taskId]);
        for (const relatedTaskId of relatedTaskIds) {
          const [leftTaskId, rightTaskId] = [taskId, relatedTaskId].sort();
          this.db.execute(`INSERT INTO task_relations (left_task_id, right_task_id, created_at) VALUES (?, ?, ?)`, [leftTaskId, rightTaskId, timestamp]);
        }
      }
      const updated = this.getById(taskId);
      if (!updated) throw new Error(`Zeus task not found after relationship update: ${taskId}`);
      return updated;
    });
  }

  /** 看板跨泳道移动写入前先复用任务关系约束做只读校验，避免多字段移动出现部分成功。 */
  validateParentChange(taskId: string, parentTaskId: string | null): void {
    const existing = this.getById(taskId);
    if (!existing) throw Object.assign(new Error('Task not found.'), { code: 'ZEUS_TASK_NOT_FOUND' as const });
    this.assertValidParent(existing.projectId, taskId, parentTaskId, this.subtreeHeight(taskId));
  }

  delete(taskId: string, input: DeleteTaskInput = {}): DeleteTaskResult {
    return this.db.transaction(() => {
      if (input.childStrategy && !['reparent', 'delete_descendants', 'make_roots'].includes(input.childStrategy)) {
        throw Object.assign(new Error('Unknown child handling strategy.'), { code: 'ZEUS_TASK_DELETE_STRATEGY_INVALID' as const });
      }
      const existing = this.getById(taskId);
      if (!existing) throw new Error(`Zeus task not found: ${taskId}`);
      const directChildren = this.listDirectChildren(taskId);
      if (directChildren.length > 0 && !input.childStrategy) {
        throw Object.assign(new Error('Deleting this task requires a child handling strategy.'), {
          code: 'ZEUS_TASK_DELETE_RELATIONSHIP_CONFIRMATION_REQUIRED' as const,
          childCount: directChildren.length,
          descendantCount: this.listDescendantIds(taskId).length,
        });
      }
      const timestamp = nextIsoTimestamp(existing.updatedAt);
      let deletedTaskIds = [taskId];
      let movedChildTaskIds: string[] = [];
      if (directChildren.length > 0 && input.childStrategy === 'reparent') {
        const replacementParentTaskId = input.replacementParentTaskId?.trim();
        if (!replacementParentTaskId) throw Object.assign(new Error('A replacement parent task is required.'), { code: 'ZEUS_TASK_REPLACEMENT_PARENT_REQUIRED' as const });
        const descendantIds = new Set(this.listDescendantIds(taskId));
        if (descendantIds.has(replacementParentTaskId)) throw Object.assign(new Error('The replacement parent cannot be inside the deleted task branch.'), { code: 'ZEUS_TASK_PARENT_CYCLE' as const });
        for (const child of directChildren) this.assertValidParent(existing.projectId, child.id, replacementParentTaskId, this.subtreeHeight(child.id));
        for (const child of directChildren) {
          this.db.execute(`UPDATE tasks SET parent_task_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [replacementParentTaskId, nextIsoTimestamp(child.updatedAt), child.id]);
        }
        movedChildTaskIds = directChildren.map((task) => task.id);
      } else if (directChildren.length > 0 && input.childStrategy === 'make_roots') {
        for (const child of directChildren) {
          this.db.execute(`UPDATE tasks SET parent_task_id = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [nextIsoTimestamp(child.updatedAt), child.id]);
        }
        movedChildTaskIds = directChildren.map((task) => task.id);
      } else if (input.childStrategy === 'delete_descendants') {
        deletedTaskIds = [taskId, ...this.listDescendantIds(taskId)];
      }
      for (const deletedTaskId of deletedTaskIds) {
        this.db.execute(`DELETE FROM task_relations WHERE left_task_id = ? OR right_task_id = ?`, [deletedTaskId, deletedTaskId]);
        this.db.execute(`UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, timestamp, deletedTaskId]);
      }
      return { task: existing, deletedTaskIds, movedChildTaskIds };
    });
  }

  listAll(options: TaskListOptions = {}): ZeusTaskRecord[] {
    const records = this.db
      .select<DbTaskRow>(
        `SELECT ${selectTaskFields}
       FROM tasks WHERE archived = 0 AND deleted_at IS NULL ORDER BY created_at ASC`,
      )
      .map(mapTaskRow);
    this.attachRelatedTaskIds(records);
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
    this.attachRelatedTaskIds(records);
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
    this.attachRelatedTaskIds(records);
    return filterAndSortTasks(records, options);
  }

  private listDirectChildren(taskId: string): ZeusTaskRecord[] {
    const rows = this.db.select<DbTaskRow>(`SELECT ${selectTaskFields} FROM tasks WHERE parent_task_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`, [taskId]).map(mapTaskRow);
    this.attachRelatedTaskIds(rows);
    return rows;
  }

  private listDescendantIds(taskId: string): string[] {
    const descendants: string[] = [];
    const queue = [taskId];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = this.db.select<{ id: string }>(`SELECT id FROM tasks WHERE parent_task_id = ? AND deleted_at IS NULL`, [parentId]);
      for (const child of children) {
        descendants.push(child.id);
        queue.push(child.id);
      }
    }
    return descendants;
  }

  private subtreeHeight(taskId: string): number {
    const children = this.db.select<{ id: string }>(`SELECT id FROM tasks WHERE parent_task_id = ? AND deleted_at IS NULL`, [taskId]);
    return children.length === 0 ? 1 : 1 + Math.max(...children.map((child) => this.subtreeHeight(child.id)));
  }

  private assertValidParent(projectId: string, taskId: string, parentTaskId: string | null, subtreeHeight: number): void {
    if (!parentTaskId) {
      if (subtreeHeight > 3) throw Object.assign(new Error('Task hierarchy cannot exceed three levels.'), { code: 'ZEUS_TASK_HIERARCHY_DEPTH_EXCEEDED' as const });
      return;
    }
    if (parentTaskId === taskId) throw Object.assign(new Error('A task cannot be its own parent.'), { code: 'ZEUS_TASK_PARENT_CYCLE' as const });
    let depth = 1;
    let cursor: string | null = parentTaskId;
    const visited = new Set<string>();
    while (cursor) {
      if (cursor === taskId || visited.has(cursor)) throw Object.assign(new Error('Task parent relationship would create a cycle.'), { code: 'ZEUS_TASK_PARENT_CYCLE' as const });
      visited.add(cursor);
      const parent: { project_id: string; parent_task_id: string | null } | undefined = this.db.get<{ project_id: string; parent_task_id: string | null }>(`SELECT project_id, parent_task_id FROM tasks WHERE id = ? AND deleted_at IS NULL`, [
        cursor,
      ]);
      if (!parent) throw Object.assign(new Error('Parent task not found.'), { code: 'ZEUS_TASK_PARENT_NOT_FOUND' as const });
      if (parent.project_id !== projectId) throw Object.assign(new Error('Parent task must belong to the same project.'), { code: 'ZEUS_TASK_RELATION_PROJECT_MISMATCH' as const });
      depth += 1;
      cursor = parent.parent_task_id;
    }
    if (depth + subtreeHeight - 1 > 3) throw Object.assign(new Error('Task hierarchy cannot exceed three levels.'), { code: 'ZEUS_TASK_HIERARCHY_DEPTH_EXCEEDED' as const });
  }

  private assertValidRelatedTasks(task: ZeusTaskRecord, relatedTaskIds: string[]): void {
    for (const relatedTaskId of relatedTaskIds) {
      if (relatedTaskId === task.id) throw Object.assign(new Error('A task cannot relate to itself.'), { code: 'ZEUS_TASK_SELF_RELATION' as const });
      const related = this.db.get<{ project_id: string }>(`SELECT project_id FROM tasks WHERE id = ? AND deleted_at IS NULL`, [relatedTaskId]);
      if (!related) throw Object.assign(new Error('Related task not found.'), { code: 'ZEUS_TASK_RELATED_NOT_FOUND' as const });
      if (related.project_id !== task.projectId) throw Object.assign(new Error('Related task must belong to the same project.'), { code: 'ZEUS_TASK_RELATION_PROJECT_MISMATCH' as const });
    }
  }

  private withRelatedTaskIds(task: ZeusTaskRecord): ZeusTaskRecord {
    task.relatedTaskIds = this.db
      .select<{ related_task_id: string }>(`SELECT CASE WHEN left_task_id = ? THEN right_task_id ELSE left_task_id END AS related_task_id FROM task_relations WHERE left_task_id = ? OR right_task_id = ?`, [task.id, task.id, task.id])
      .map((row) => row.related_task_id);
    return task;
  }

  private attachRelatedTaskIds(tasks: ZeusTaskRecord[]): void {
    if (tasks.length === 0) return;
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const placeholders = tasks.map(() => '?').join(', ');
    const relations = this.db.select<{ left_task_id: string; right_task_id: string }>(`SELECT left_task_id, right_task_id FROM task_relations WHERE left_task_id IN (${placeholders}) OR right_task_id IN (${placeholders})`, [
      ...taskById.keys(),
      ...taskById.keys(),
    ]);
    for (const relation of relations) {
      taskById.get(relation.left_task_id)?.relatedTaskIds.push(relation.right_task_id);
      taskById.get(relation.right_task_id)?.relatedTaskIds.push(relation.left_task_id);
    }
  }
}

interface DbTaskBoardViewRow {
  project_id: string;
  settings_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface DbTaskBoardPositionRow {
  project_id: string;
  layout_key: string;
  group_id: string;
  subgroup_id: string;
  task_id: string;
  rank: number;
  updated_at: string;
}

function taskBoardRevisionConflict(currentRevision: number): Error {
  return Object.assign(new Error('Task board changed after editing started.'), {
    code: 'ZEUS_TASK_BOARD_REVISION_CONFLICT' as const,
    currentRevision,
  });
}

/** 任务看板仓储只保存项目视图配置和手工顺序，不复制任务业务字段。 */
export class TaskBoardRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  getSnapshot(projectId: string): TaskBoardViewSnapshot {
    const view = this.db.get<DbTaskBoardViewRow>(`SELECT project_id, settings_json, revision, created_at, updated_at FROM task_board_views WHERE project_id = ?`, [projectId]);
    let settings = createDefaultTaskBoardViewSettings();
    if (view) {
      try {
        settings = normalizeTaskBoardViewSettings(JSON.parse(view.settings_json));
      } catch {
        settings = createDefaultTaskBoardViewSettings();
      }
    }
    const positions = this.db
      .select<DbTaskBoardPositionRow>(
        `SELECT project_id, layout_key, group_id, subgroup_id, task_id, rank, updated_at
         FROM task_board_positions WHERE project_id = ? ORDER BY layout_key, group_id, subgroup_id, rank, task_id`,
        [projectId],
      )
      .map(mapTaskBoardPositionRow);
    return {
      projectId,
      revision: view?.revision ?? 0,
      settings,
      positions,
      updatedAt: view?.updated_at ?? null,
    };
  }

  updateSettings(projectId: string, expectedRevision: number, patch: Partial<TaskBoardViewSettings>): TaskBoardViewSnapshot {
    const current = this.getSnapshot(projectId);
    if (current.revision !== expectedRevision) throw taskBoardRevisionConflict(current.revision);
    const settings = normalizeTaskBoardViewSettings({ ...current.settings, ...patch }, current.settings);
    if (JSON.stringify(settings) === JSON.stringify(current.settings)) return current;
    this.db.transaction(() => {
      const timestamp = nowIso();
      const existing = this.db.get<{ revision: number }>(`SELECT revision FROM task_board_views WHERE project_id = ?`, [projectId]);
      if ((existing?.revision ?? 0) !== expectedRevision) throw taskBoardRevisionConflict(existing?.revision ?? 0);
      if (existing) {
        this.db.execute(`UPDATE task_board_views SET settings_json = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND revision = ?`, [JSON.stringify(settings), timestamp, projectId, expectedRevision]);
      } else {
        this.db.execute(`INSERT INTO task_board_views (project_id, settings_json, revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`, [projectId, JSON.stringify(settings), timestamp, timestamp]);
      }
    });
    return this.getSnapshot(projectId);
  }

  replaceLaneOrder(input: {
    projectId: string;
    taskId: string;
    layoutKey: string;
    source: TaskBoardLaneIdentity;
    target: TaskBoardLaneIdentity;
    orderedTaskIds: string[];
    expectedRevision: number;
    /** 多选标签移入“无标签”且仍保留其他标签时，只移除来源出现位置，不创建不存在的目标卡片。 */
    includeTaskInTarget?: boolean;
  }): TaskBoardViewSnapshot {
    const current = this.getSnapshot(input.projectId);
    if (current.revision !== input.expectedRevision) throw taskBoardRevisionConflict(current.revision);
    const orderedTaskIds = Array.from(new Set(input.orderedTaskIds.filter(Boolean)));
    this.db.transaction(() => {
      const timestamp = nowIso();
      const existing = this.db.get<{ revision: number }>(`SELECT revision FROM task_board_views WHERE project_id = ?`, [input.projectId]);
      if ((existing?.revision ?? 0) !== input.expectedRevision) throw taskBoardRevisionConflict(existing?.revision ?? 0);
      if (!existing) {
        this.db.execute(`INSERT INTO task_board_views (project_id, settings_json, revision, created_at, updated_at) VALUES (?, ?, 0, ?, ?)`, [input.projectId, JSON.stringify(current.settings), timestamp, timestamp]);
      }
      const targetSubgroupId = input.target.subgroupId ?? '';
      for (const lane of [input.source, input.target]) {
        this.db.execute(`DELETE FROM task_board_positions WHERE project_id = ? AND layout_key = ? AND group_id = ? AND subgroup_id = ? AND task_id NOT IN (SELECT id FROM tasks WHERE deleted_at IS NULL)`, [
          input.projectId,
          input.layoutKey,
          lane.groupId,
          lane.subgroupId ?? '',
        ]);
      }
      const existingTargetRanks = new Map(
        this.db
          .select<{
            task_id: string;
            rank: number;
          }>(`SELECT task_id, rank FROM task_board_positions WHERE project_id = ? AND layout_key = ? AND group_id = ? AND subgroup_id = ? ORDER BY rank, task_id`, [input.projectId, input.layoutKey, input.target.groupId, targetSubgroupId])
          .map((row) => [row.task_id, row.rank]),
      );
      const sourceSubgroupId = input.source.subgroupId ?? '';
      if (input.source.groupId !== input.target.groupId) {
        // 主分组变化会让该任务在来源列内的全部标签子组出现位置失效，但不得删除其他仍然有效的标签列位置。
        this.db.execute(`DELETE FROM task_board_positions WHERE project_id = ? AND layout_key = ? AND group_id = ? AND task_id = ?`, [input.projectId, input.layoutKey, input.source.groupId, input.taskId]);
      } else if (sourceSubgroupId !== targetSubgroupId) {
        this.db.execute(`DELETE FROM task_board_positions WHERE project_id = ? AND layout_key = ? AND group_id = ? AND subgroup_id = ? AND task_id = ?`, [
          input.projectId,
          input.layoutKey,
          input.source.groupId,
          sourceSubgroupId,
          input.taskId,
        ]);
      }
      this.db.execute(`DELETE FROM task_board_positions WHERE project_id = ? AND layout_key = ? AND group_id = ? AND subgroup_id = ? AND task_id = ?`, [
        input.projectId,
        input.layoutKey,
        input.target.groupId,
        targetSubgroupId,
        input.taskId,
      ]);
      existingTargetRanks.delete(input.taskId);
      const movedIndex = orderedTaskIds.indexOf(input.taskId);
      if (input.includeTaskInTarget === false) {
        this.db.execute(`UPDATE task_board_views SET revision = revision + 1, updated_at = ? WHERE project_id = ?`, [timestamp, input.projectId]);
        return;
      }
      const previousTaskId = movedIndex > 0 ? orderedTaskIds[movedIndex - 1] : undefined;
      const nextTaskId = movedIndex >= 0 && movedIndex < orderedTaskIds.length - 1 ? orderedTaskIds[movedIndex + 1] : undefined;
      const previousRank = previousTaskId ? existingTargetRanks.get(previousTaskId) : undefined;
      const nextRank = nextTaskId ? existingTargetRanks.get(nextTaskId) : undefined;
      const sparseRank =
        !previousTaskId && !nextTaskId
          ? 1024
          : previousTaskId && previousRank === undefined
            ? null
            : nextTaskId && nextRank === undefined
              ? null
              : previousRank === undefined && nextRank !== undefined
                ? nextRank > 1
                  ? Math.floor(nextRank / 2)
                  : null
                : previousRank !== undefined && nextRank === undefined
                  ? previousRank + 1024
                  : previousRank !== undefined && nextRank !== undefined && nextRank - previousRank > 1
                    ? previousRank + Math.floor((nextRank - previousRank) / 2)
                    : null;
      if (sparseRank !== null) {
        this.db.execute(
          `INSERT INTO task_board_positions (project_id, layout_key, group_id, subgroup_id, task_id, rank, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, layout_key, group_id, subgroup_id, task_id)
           DO UPDATE SET rank = excluded.rank, updated_at = excluded.updated_at`,
          [input.projectId, input.layoutKey, input.target.groupId, targetSubgroupId, input.taskId, sparseRank, timestamp],
        );
      } else {
        // 只有相邻序号耗尽或泳道尚未建立完整序号时，才重排受影响的目标泳道。
        this.db.execute(`DELETE FROM task_board_positions WHERE project_id = ? AND layout_key = ? AND group_id = ? AND subgroup_id = ?`, [input.projectId, input.layoutKey, input.target.groupId, targetSubgroupId]);
        orderedTaskIds.forEach((taskId, index) => {
          this.db.execute(
            `INSERT INTO task_board_positions (project_id, layout_key, group_id, subgroup_id, task_id, rank, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [input.projectId, input.layoutKey, input.target.groupId, targetSubgroupId, taskId, (index + 1) * 1024, timestamp],
          );
        });
      }
      this.db.execute(`UPDATE task_board_views SET revision = revision + 1, updated_at = ? WHERE project_id = ?`, [timestamp, input.projectId]);
    });
    return this.getSnapshot(input.projectId);
  }
}

function mapTaskBoardPositionRow(row: DbTaskBoardPositionRow): TaskBoardPosition {
  return {
    projectId: row.project_id,
    layoutKey: row.layout_key,
    groupId: row.group_id,
    subgroupId: row.subgroup_id,
    taskId: row.task_id,
    rank: row.rank,
    updatedAt: row.updated_at,
  };
}

const selectProjectRepositoryFields = `id, project_id, name, relative_path, local_path, created_at, updated_at`;

/** 项目仓库登记只保存用户确认后的仓库集合，扫描候选不会自动进入持久记录。 */
export class ProjectRepositoryRegistrationRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  listByProject(projectId: string): ZeusProjectRepositoryRecord[] {
    return this.db.select<DbProjectRepositoryRow>(`SELECT ${selectProjectRepositoryFields} FROM project_repositories WHERE project_id = ? ORDER BY relative_path, id`, [projectId]).map(mapProjectRepositoryRow);
  }

  getById(repositoryId: string): ZeusProjectRepositoryRecord | undefined {
    const row = this.db.get<DbProjectRepositoryRow>(`SELECT ${selectProjectRepositoryFields} FROM project_repositories WHERE id = ?`, [repositoryId]);
    return row ? mapProjectRepositoryRow(row) : undefined;
  }

  replaceForProject(projectId: string, inputs: CreateProjectRepositoryInput[]): ZeusProjectRepositoryRecord[] {
    return this.db.transaction(() => {
      const existing = new Map(this.listByProject(projectId).map((record) => [record.localPath, record]));
      this.db.execute(`DELETE FROM project_repositories WHERE project_id = ?`, [projectId]);
      const timestamp = nowIso();
      for (const input of inputs) {
        const prior = existing.get(input.localPath);
        this.db.execute(`INSERT INTO project_repositories (id, project_id, name, relative_path, local_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
          input.id ?? prior?.id ?? `project_repository_${nanoid(12)}`,
          projectId,
          input.name,
          input.relativePath,
          input.localPath,
          prior?.createdAt ?? timestamp,
          timestamp,
        ]);
      }
      return this.listByProject(projectId);
    });
  }
}

const selectProjectSharedPathFields = `id, project_id, relative_path, local_path, created_at, updated_at`;

/** 共享可写目录必须由用户显式登记；默认不存在隐式写入根。 */
export class ProjectSharedPathRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  listByProject(projectId: string): ZeusProjectSharedPathRecord[] {
    return this.db.select<DbProjectSharedPathRow>(`SELECT ${selectProjectSharedPathFields} FROM project_shared_paths WHERE project_id = ? ORDER BY relative_path, id`, [projectId]).map(mapProjectSharedPathRow);
  }

  replaceForProject(projectId: string, inputs: CreateProjectSharedPathInput[]): ZeusProjectSharedPathRecord[] {
    return this.db.transaction(() => {
      const existing = new Map(this.listByProject(projectId).map((record) => [record.localPath, record]));
      this.db.execute(`DELETE FROM project_shared_paths WHERE project_id = ?`, [projectId]);
      const timestamp = nowIso();
      for (const input of inputs) {
        const prior = existing.get(input.localPath);
        this.db.execute(`INSERT INTO project_shared_paths (id, project_id, relative_path, local_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [
          input.id ?? prior?.id ?? `project_shared_path_${nanoid(12)}`,
          projectId,
          input.relativePath,
          input.localPath,
          prior?.createdAt ?? timestamp,
          timestamp,
        ]);
      }
      return this.listByProject(projectId);
    });
  }
}

const selectTaskEnvironmentFields = `id, project_id, task_id, root_path, state, last_error, created_at, updated_at`;

/** 任务环境保存多仓工作区的共同根和整体生命周期。 */
export class TaskEnvironmentRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  create(input: CreateTaskEnvironmentInput): ZeusTaskEnvironmentRecord {
    const timestamp = nowIso();
    const record: ZeusTaskEnvironmentRecord = {
      id: input.id ?? `task_environment_${nanoid(12)}`,
      projectId: input.projectId,
      taskId: input.taskId,
      rootPath: input.rootPath ?? null,
      state: assertEnum(input.state ?? 'ready', ['ready', 'reclaimed', 'failed'] as const, 'task environment state'),
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.execute(`INSERT INTO task_environments (id, project_id, task_id, root_path, state, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`, [
      record.id,
      record.projectId,
      record.taskId,
      record.rootPath,
      record.state,
      record.createdAt,
      record.updatedAt,
    ]);
    return record;
  }

  getById(environmentId: string): ZeusTaskEnvironmentRecord | undefined {
    const row = this.db.get<DbTaskEnvironmentRow>(`SELECT ${selectTaskEnvironmentFields} FROM task_environments WHERE id = ?`, [environmentId]);
    return row ? mapTaskEnvironmentRow(row) : undefined;
  }

  listByTask(taskId: string): ZeusTaskEnvironmentRecord[] {
    return this.db.select<DbTaskEnvironmentRow>(`SELECT ${selectTaskEnvironmentFields} FROM task_environments WHERE task_id = ? ORDER BY updated_at DESC, id`, [taskId]).map(mapTaskEnvironmentRow);
  }

  update(environmentId: string, input: UpdateTaskEnvironmentInput): ZeusTaskEnvironmentRecord {
    const existing = this.getById(environmentId);
    if (!existing) throw new Error(`Zeus task environment not found: ${environmentId}`);
    const state = input.state ? assertEnum(input.state, ['ready', 'reclaimed', 'failed'] as const, 'task environment state') : existing.state;
    this.db.execute(`UPDATE task_environments SET root_path = ?, state = ?, last_error = ?, updated_at = ? WHERE id = ?`, [
      'rootPath' in input ? (input.rootPath ?? null) : existing.rootPath,
      state,
      'lastError' in input ? (input.lastError ?? null) : existing.lastError,
      nowIso(),
      environmentId,
    ]);
    return this.getById(environmentId)!;
  }

  delete(environmentId: string): void {
    this.db.execute(`DELETE FROM task_environments WHERE id = ?`, [environmentId]);
  }
}

const selectTaskWorkspaceFields = `id, project_id, task_id, workspace_kind, base_workspace_id, branch_name, source_branch, source_head_sha, remote_name,
  remote_branch, worktree_path, head_sha, state, last_error, created_at, updated_at,
  environment_id, repository_id, repository_name, repository_relative_path, repository_path`;

/** 任务工作区仓储只记录 Git 身份与生命周期，不代替 Git 本身作为分支状态真相源。 */
export class TaskWorkspaceRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  create(input: CreateTaskWorkspaceInput): ZeusTaskWorkspaceRecord {
    const timestamp = nowIso();
    const state = assertEnum(input.state ?? 'ready', ['ready', 'reclaimed', 'merged', 'discarded', 'failed'] as const, 'task workspace state');
    const record: ZeusTaskWorkspaceRecord = {
      id: input.id ?? `task_workspace_${nanoid(12)}`,
      projectId: input.projectId,
      taskId: input.taskId,
      kind: assertEnum(input.kind ?? 'task', ['task', 'conflict'] as const, 'task workspace kind'),
      baseWorkspaceId: input.baseWorkspaceId ?? null,
      environmentId: input.environmentId ?? null,
      repositoryId: input.repositoryId ?? null,
      repositoryName: input.repositoryName ?? '项目仓库',
      repositoryRelativePath: input.repositoryRelativePath ?? '.',
      repositoryPath: input.repositoryPath ?? '',
      branchName: input.branchName,
      sourceBranch: input.sourceBranch,
      sourceHeadSha: input.sourceHeadSha,
      remoteName: input.remoteName ?? 'origin',
      remoteBranch: input.remoteBranch ?? input.branchName,
      worktreePath: input.worktreePath ?? null,
      headSha: input.headSha ?? null,
      state,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.execute(
      `INSERT INTO task_workspaces
       (id, project_id, task_id, workspace_kind, base_workspace_id, branch_name, source_branch, source_head_sha, remote_name, remote_branch,
        worktree_path, head_sha, state, last_error, created_at, updated_at,
        environment_id, repository_id, repository_name, repository_relative_path, repository_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.projectId,
        record.taskId,
        record.kind,
        record.baseWorkspaceId,
        record.branchName,
        record.sourceBranch,
        record.sourceHeadSha,
        record.remoteName,
        record.remoteBranch,
        record.worktreePath,
        record.headSha,
        record.state,
        record.createdAt,
        record.updatedAt,
        record.environmentId,
        record.repositoryId,
        record.repositoryName,
        record.repositoryRelativePath,
        record.repositoryPath,
      ],
    );
    return record;
  }

  getById(workspaceId: string): ZeusTaskWorkspaceRecord | undefined {
    const row = this.db.get<DbTaskWorkspaceRow>(`SELECT ${selectTaskWorkspaceFields} FROM task_workspaces WHERE id = ?`, [workspaceId]);
    return row ? mapTaskWorkspaceRow(row) : undefined;
  }

  getByProjectBranch(projectId: string, branchName: string): ZeusTaskWorkspaceRecord | undefined {
    const row = this.db.get<DbTaskWorkspaceRow>(`SELECT ${selectTaskWorkspaceFields} FROM task_workspaces WHERE project_id = ? AND branch_name = ?`, [projectId, branchName]);
    return row ? mapTaskWorkspaceRow(row) : undefined;
  }

  getByRepositoryBranch(repositoryId: string, branchName: string): ZeusTaskWorkspaceRecord | undefined {
    const row = this.db.get<DbTaskWorkspaceRow>(`SELECT ${selectTaskWorkspaceFields} FROM task_workspaces WHERE repository_id = ? AND branch_name = ?`, [repositoryId, branchName]);
    return row ? mapTaskWorkspaceRow(row) : undefined;
  }

  listByEnvironment(environmentId: string): ZeusTaskWorkspaceRecord[] {
    return this.db.select<DbTaskWorkspaceRow>(`SELECT ${selectTaskWorkspaceFields} FROM task_workspaces WHERE environment_id = ? ORDER BY repository_relative_path, id`, [environmentId]).map(mapTaskWorkspaceRow);
  }

  listByTask(taskId: string): ZeusTaskWorkspaceRecord[] {
    return this.db.select<DbTaskWorkspaceRow>(`SELECT ${selectTaskWorkspaceFields} FROM task_workspaces WHERE task_id = ? ORDER BY created_at, id`, [taskId]).map(mapTaskWorkspaceRow);
  }

  listByProject(projectId: string): ZeusTaskWorkspaceRecord[] {
    return this.db.select<DbTaskWorkspaceRow>(`SELECT ${selectTaskWorkspaceFields} FROM task_workspaces WHERE project_id = ? ORDER BY updated_at DESC, id`, [projectId]).map(mapTaskWorkspaceRow);
  }

  update(workspaceId: string, input: UpdateTaskWorkspaceInput): ZeusTaskWorkspaceRecord {
    const existing = this.getById(workspaceId);
    if (!existing) throw new Error(`Zeus task workspace not found: ${workspaceId}`);
    const state = input.state ? assertEnum(input.state, ['ready', 'reclaimed', 'merged', 'discarded', 'failed'] as const, 'task workspace state') : existing.state;
    this.db.execute(
      `UPDATE task_workspaces
       SET worktree_path = ?, head_sha = ?, state = ?, remote_branch = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [
        'worktreePath' in input ? (input.worktreePath ?? null) : existing.worktreePath,
        'headSha' in input ? (input.headSha ?? null) : existing.headSha,
        state,
        input.remoteBranch ?? existing.remoteBranch,
        'lastError' in input ? (input.lastError ?? null) : existing.lastError,
        nowIso(),
        workspaceId,
      ],
    );
    return this.getById(workspaceId)!;
  }

  delete(workspaceId: string): void {
    this.db.execute(`DELETE FROM task_workspaces WHERE id = ?`, [workspaceId]);
  }
}

const selectTaskIntegrationFields = `id, project_id, task_id, workspace_id, target_branch, target_head_sha, task_head_sha, mode,
  integration_path, result_head_sha, state, local_sync_status, local_head_sha, local_worktree_path,
  conflict_files_json, last_error, created_at, updated_at`;

/** 合入记录保存隔离集成 worktree 的恢复身份，使冲突处理可以跨应用重启继续。 */
export class TaskIntegrationRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  create(input: CreateTaskIntegrationInput): ZeusTaskIntegrationRecord {
    const timestamp = nowIso();
    const mode = assertEnum(input.mode, ['merge', 'squash'] as const, 'task integration mode');
    const state = assertEnum(input.state ?? 'preparing', ['preparing', 'conflicted', 'pending_local_sync', 'merged', 'failed'] as const, 'task integration state');
    const record: ZeusTaskIntegrationRecord = {
      id: input.id ?? `task_integration_${nanoid(12)}`,
      projectId: input.projectId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      targetBranch: input.targetBranch,
      targetHeadSha: input.targetHeadSha,
      taskHeadSha: input.taskHeadSha,
      mode,
      integrationPath: input.integrationPath ?? null,
      resultHeadSha: null,
      state,
      localSyncStatus: null,
      localHeadSha: null,
      localWorktreePath: null,
      conflictFiles: [],
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.execute(
      `INSERT INTO task_integrations
       (id, project_id, task_id, workspace_id, target_branch, target_head_sha, task_head_sha, mode, integration_path,
        result_head_sha, state, local_sync_status, local_head_sha, local_worktree_path,
        conflict_files_json, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, '[]', NULL, ?, ?)`,
      [record.id, record.projectId, record.taskId, record.workspaceId, record.targetBranch, record.targetHeadSha, record.taskHeadSha, record.mode, record.integrationPath, record.state, record.createdAt, record.updatedAt],
    );
    return record;
  }

  getById(integrationId: string): ZeusTaskIntegrationRecord | undefined {
    const row = this.db.get<DbTaskIntegrationRow>(`SELECT ${selectTaskIntegrationFields} FROM task_integrations WHERE id = ?`, [integrationId]);
    return row ? mapTaskIntegrationRow(row) : undefined;
  }

  findActive(workspaceId: string, targetBranch: string): ZeusTaskIntegrationRecord | undefined {
    const row = this.db.get<DbTaskIntegrationRow>(
      `SELECT ${selectTaskIntegrationFields} FROM task_integrations WHERE workspace_id = ? AND target_branch = ? AND state IN ('preparing', 'conflicted', 'pending_local_sync') ORDER BY updated_at DESC LIMIT 1`,
      [workspaceId, targetBranch],
    );
    return row ? mapTaskIntegrationRow(row) : undefined;
  }

  listByTask(taskId: string): ZeusTaskIntegrationRecord[] {
    return this.db.select<DbTaskIntegrationRow>(`SELECT ${selectTaskIntegrationFields} FROM task_integrations WHERE task_id = ? ORDER BY updated_at DESC, id`, [taskId]).map(mapTaskIntegrationRow);
  }

  update(integrationId: string, input: UpdateTaskIntegrationInput): ZeusTaskIntegrationRecord {
    const existing = this.getById(integrationId);
    if (!existing) throw new Error(`Zeus task integration not found: ${integrationId}`);
    const state = input.state ? assertEnum(input.state, ['preparing', 'conflicted', 'pending_local_sync', 'merged', 'failed'] as const, 'task integration state') : existing.state;
    this.db.execute(
      `UPDATE task_integrations
       SET integration_path = ?, result_head_sha = ?, state = ?, local_sync_status = ?, local_head_sha = ?,
           local_worktree_path = ?, conflict_files_json = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [
        'integrationPath' in input ? (input.integrationPath ?? null) : existing.integrationPath,
        'resultHeadSha' in input ? (input.resultHeadSha ?? null) : existing.resultHeadSha,
        state,
        'localSyncStatus' in input ? (input.localSyncStatus ?? null) : existing.localSyncStatus,
        'localHeadSha' in input ? (input.localHeadSha ?? null) : existing.localHeadSha,
        'localWorktreePath' in input ? (input.localWorktreePath ?? null) : existing.localWorktreePath,
        JSON.stringify(input.conflictFiles ?? existing.conflictFiles),
        'lastError' in input ? (input.lastError ?? null) : existing.lastError,
        nowIso(),
        integrationId,
      ],
    );
    return this.getById(integrationId)!;
  }
}

const selectTaskIntegrationAttemptFields = `id, integration_id, conversation_id, submission_id, worktree_path,
  target_head_sha, task_head_sha, state, result_head_sha, last_error, created_at, updated_at`;

/** 每次显式 AI 冲突处理都拥有独立 worktree；记录用于重启后的恢复与过期判定。 */
export class TaskIntegrationAttemptRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  create(input: CreateTaskIntegrationAttemptInput): ZeusTaskIntegrationAttemptRecord {
    const timestamp = nowIso();
    const state = assertEnum(input.state ?? 'preparing', ['preparing', 'active', 'completed', 'failed', 'stale'] as const, 'task integration attempt state');
    this.db.execute(
      `INSERT INTO task_integration_attempts
       (id, integration_id, conversation_id, submission_id, worktree_path, target_head_sha, task_head_sha, state,
        result_head_sha, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [input.id, input.integrationId, input.conversationId, input.submissionId, input.worktreePath, input.targetHeadSha, input.taskHeadSha, state, timestamp, timestamp],
    );
    return this.getById(input.id)!;
  }

  getById(attemptId: string): ZeusTaskIntegrationAttemptRecord | undefined {
    const row = this.db.get<DbTaskIntegrationAttemptRow>(`SELECT ${selectTaskIntegrationAttemptFields} FROM task_integration_attempts WHERE id = ?`, [attemptId]);
    return row ? mapTaskIntegrationAttemptRow(row) : undefined;
  }

  getByConversationId(conversationId: string): ZeusTaskIntegrationAttemptRecord | undefined {
    const row = this.db.get<DbTaskIntegrationAttemptRow>(`SELECT ${selectTaskIntegrationAttemptFields} FROM task_integration_attempts WHERE conversation_id = ?`, [conversationId]);
    return row ? mapTaskIntegrationAttemptRow(row) : undefined;
  }

  listByIntegration(integrationId: string): ZeusTaskIntegrationAttemptRecord[] {
    return this.db.select<DbTaskIntegrationAttemptRow>(`SELECT ${selectTaskIntegrationAttemptFields} FROM task_integration_attempts WHERE integration_id = ? ORDER BY created_at, id`, [integrationId]).map(mapTaskIntegrationAttemptRow);
  }

  listByState(stateValue: TaskIntegrationAttemptState): ZeusTaskIntegrationAttemptRecord[] {
    const state = assertEnum(stateValue, ['preparing', 'active', 'completed', 'failed', 'stale'] as const, 'task integration attempt state');
    return this.db.select<DbTaskIntegrationAttemptRow>(`SELECT ${selectTaskIntegrationAttemptFields} FROM task_integration_attempts WHERE state = ? ORDER BY created_at, id`, [state]).map(mapTaskIntegrationAttemptRow);
  }

  update(attemptId: string, input: UpdateTaskIntegrationAttemptInput): ZeusTaskIntegrationAttemptRecord {
    const existing = this.getById(attemptId);
    if (!existing) throw new Error(`Zeus task integration attempt not found: ${attemptId}`);
    const state = input.state ? assertEnum(input.state, ['preparing', 'active', 'completed', 'failed', 'stale'] as const, 'task integration attempt state') : existing.state;
    this.db.execute(`UPDATE task_integration_attempts SET worktree_path = ?, target_head_sha = ?, task_head_sha = ?, state = ?, result_head_sha = ?, last_error = ?, updated_at = ? WHERE id = ?`, [
      input.worktreePath ?? existing.worktreePath,
      input.targetHeadSha ?? existing.targetHeadSha,
      input.taskHeadSha ?? existing.taskHeadSha,
      state,
      'resultHeadSha' in input ? (input.resultHeadSha ?? null) : existing.resultHeadSha,
      'lastError' in input ? (input.lastError ?? null) : existing.lastError,
      nowIso(),
      attemptId,
    ]);
    return this.getById(attemptId)!;
  }
}

/** 任务模板是产品 prompt 定义，不是项目、任务、会话或执行结果数据。 */
export class TaskTemplateRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  createCustom(input: CreateTaskTemplateInput): ZeusTaskTemplateRecord {
    const timestamp = nowIso();
    const record: ZeusTaskTemplateRecord = {
      id: input.id ?? `task_template_${nanoid(12)}`,
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
  constructor(private readonly db: ZeusDatabasePort) {}

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
    return this.db.select<DbTaskEventRow>(`SELECT id, task_id, event_type, title, payload_json, created_at FROM task_events WHERE task_id = ? ORDER BY rowid ASC`, [taskId]).map(mapTaskEventRow);
  }

  getProjectionCursor(eventId: string): { id: string; taskId: string; sequence: number } | null {
    const row = this.db.get<{ id: string; task_id: string; event_sequence: number }>(`SELECT id, task_id, rowid AS event_sequence FROM task_events WHERE id = ?`, [eventId]);
    return row ? { id: row.id, taskId: row.task_id, sequence: row.event_sequence } : null;
  }

  listProjectionBatch(input: { taskId: string; afterSequence: number; throughSequence: number; limit: number }): Array<{ event: ZeusTaskEventRecord; sequence: number }> {
    return this.db
      .select<DbTaskEventRow & { event_sequence: number }>(
        `SELECT id, task_id, event_type, title, payload_json, created_at, rowid AS event_sequence
         FROM task_events
         WHERE task_id = ? AND rowid > ? AND rowid <= ?
         ORDER BY rowid ASC LIMIT ?`,
        [input.taskId, input.afterSequence, input.throughSequence, input.limit],
      )
      .map((row) => ({ event: mapTaskEventRow(row), sequence: row.event_sequence }));
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

interface DbProjectRepositoryRow {
  id: string;
  project_id: string;
  name: string;
  relative_path: string;
  local_path: string;
  created_at: string;
  updated_at: string;
}

interface DbProjectSharedPathRow {
  id: string;
  project_id: string;
  relative_path: string;
  local_path: string;
  created_at: string;
  updated_at: string;
}

interface DbTaskEnvironmentRow {
  id: string;
  project_id: string;
  task_id: string;
  root_path: string | null;
  state: TaskEnvironmentState;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface DbTaskRow {
  id: string;
  project_id: string;
  task_code: string | null;
  task_sequence: number | null;
  parent_task_id: string | null;
  title: string;
  task_type: string;
  description: string;
  defect_current_state: string;
  defect_expected_outcome: string;
  defect_reproduction_steps: string;
  optimization_current_state: string;
  optimization_expected_outcome: string;
  management_status: string;
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

interface DbTaskWorkspaceRow {
  id: string;
  project_id: string;
  task_id: string;
  workspace_kind: TaskWorkspaceKind;
  base_workspace_id: string | null;
  environment_id: string | null;
  repository_id: string | null;
  repository_name: string;
  repository_relative_path: string;
  repository_path: string;
  branch_name: string;
  source_branch: string;
  source_head_sha: string;
  remote_name: string;
  remote_branch: string;
  worktree_path: string | null;
  head_sha: string | null;
  state: TaskWorkspaceState;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface DbTaskIntegrationRow {
  id: string;
  project_id: string;
  task_id: string;
  workspace_id: string;
  target_branch: string;
  target_head_sha: string;
  task_head_sha: string | null;
  mode: TaskIntegrationMode;
  integration_path: string | null;
  result_head_sha: string | null;
  state: TaskIntegrationState;
  local_sync_status: TaskIntegrationLocalSyncStatus | null;
  local_head_sha: string | null;
  local_worktree_path: string | null;
  conflict_files_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface DbTaskIntegrationAttemptRow {
  id: string;
  integration_id: string;
  conversation_id: string;
  submission_id: string;
  worktree_path: string;
  target_head_sha: string;
  task_head_sha: string;
  state: TaskIntegrationAttemptState;
  result_head_sha: string | null;
  last_error: string | null;
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

function mapProjectRepositoryRow(row: DbProjectRepositoryRow): ZeusProjectRepositoryRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    relativePath: row.relative_path,
    localPath: row.local_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProjectSharedPathRow(row: DbProjectSharedPathRow): ZeusProjectSharedPathRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    relativePath: row.relative_path,
    localPath: row.local_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskEnvironmentRow(row: DbTaskEnvironmentRow): ZeusTaskEnvironmentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    rootPath: row.root_path,
    state: assertEnum(row.state, ['ready', 'reclaimed', 'failed'] as const, 'task environment state'),
    lastError: row.last_error,
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
    parentTaskId: row.parent_task_id,
    relatedTaskIds: [],
    title: row.title,
    taskType: isTaskType(row.task_type) ? row.task_type : 'requirement',
    description: row.description,
    defectCurrentState: row.defect_current_state ?? '',
    defectExpectedOutcome: row.defect_expected_outcome ?? '',
    defectReproductionSteps: row.defect_reproduction_steps ?? '',
    optimizationCurrentState: row.optimization_current_state ?? '',
    optimizationExpectedOutcome: row.optimization_expected_outcome ?? '',
    managementStatus: isTaskManagementStatus(row.management_status) ? row.management_status : 'todo',
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

function mapTaskWorkspaceRow(row: DbTaskWorkspaceRow): ZeusTaskWorkspaceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    kind: assertEnum(row.workspace_kind, ['task', 'conflict'] as const, 'task workspace kind'),
    baseWorkspaceId: row.base_workspace_id,
    environmentId: row.environment_id,
    repositoryId: row.repository_id,
    repositoryName: row.repository_name,
    repositoryRelativePath: row.repository_relative_path,
    repositoryPath: row.repository_path,
    branchName: row.branch_name,
    sourceBranch: row.source_branch,
    sourceHeadSha: row.source_head_sha,
    remoteName: row.remote_name,
    remoteBranch: row.remote_branch,
    worktreePath: row.worktree_path,
    headSha: row.head_sha,
    state: assertEnum(row.state, ['ready', 'reclaimed', 'merged', 'discarded', 'failed'] as const, 'task workspace state'),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskIntegrationRow(row: DbTaskIntegrationRow): ZeusTaskIntegrationRecord {
  let conflictFiles: string[] = [];
  try {
    const parsed = JSON.parse(row.conflict_files_json) as unknown;
    if (Array.isArray(parsed)) conflictFiles = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    conflictFiles = [];
  }
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    targetBranch: row.target_branch,
    targetHeadSha: row.target_head_sha,
    taskHeadSha: row.task_head_sha,
    mode: assertEnum(row.mode, ['merge', 'squash'] as const, 'task integration mode'),
    integrationPath: row.integration_path,
    resultHeadSha: row.result_head_sha,
    state: assertEnum(row.state, ['preparing', 'conflicted', 'pending_local_sync', 'merged', 'failed'] as const, 'task integration state'),
    localSyncStatus: row.local_sync_status ? assertEnum(row.local_sync_status, ['synced', 'pending'] as const, 'task integration local sync status') : null,
    localHeadSha: row.local_head_sha,
    localWorktreePath: row.local_worktree_path,
    conflictFiles,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaskIntegrationAttemptRow(row: DbTaskIntegrationAttemptRow): ZeusTaskIntegrationAttemptRecord {
  return {
    id: row.id,
    integrationId: row.integration_id,
    conversationId: row.conversation_id,
    submissionId: row.submission_id,
    worktreePath: row.worktree_path,
    targetHeadSha: row.target_head_sha,
    taskHeadSha: row.task_head_sha,
    state: assertEnum(row.state, ['preparing', 'active', 'completed', 'failed', 'stale'] as const, 'task integration attempt state'),
    resultHeadSha: row.result_head_sha,
    lastError: row.last_error,
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
