import type {
  AiRuntimeSession,
  AiRuntimeSessionStatus,
  TaskAgentRunStatus,
  TaskManagementStatus,
  TaskRecord,
  TaskStatusFilter,
  TaskTableColumnKey,
  TaskTableColumnPreferences,
  TaskTableColumnWidth,
  TaskTableEnumSortOrders,
  TaskTableSortState,
  TaskType,
} from '../apiClient.js';
import type { NativeConversationChoice, NativeSessionState } from '../session/sessionTypes.js';
import { compareConversationStageUpdatedDesc } from '../session/conversationOrdering.js';

export type TaskWorkspaceEmptyState = 'empty' | 'no-results' | undefined;
export type TaskWorkspaceViewMode = 'hierarchy' | 'flat';
export type TaskRowAction = 'open-detail';
export type TaskTableColumnDropPosition = 'before' | 'after';
export type TaskBranchStatus = 'action_required' | 'active' | 'pushed' | 'merged' | 'discarded' | 'not_created';
export type TaskSourceLabels = Partial<Record<string, string>>;
export type { TaskAgentRunStatus } from '../apiClient.js';

export const taskManagementStatuses: TaskManagementStatus[] = ['todo', 'in_development', 'in_testing', 'awaiting_acceptance', 'blocked', 'completed', 'cancelled'];
export const taskTypes: TaskType[] = ['requirement', 'defect', 'optimization'];
export const defaultTaskTableColumnOrder: TaskTableColumnKey[] = [
  'code',
  'intent',
  'taskType',
  'managementStatus',
  'branchStatus',
  'runStatus',
  'source',
  'createdAt',
  'updatedAt',
  'template',
  'project',
  'priority',
  'description',
  'runtimeSession',
  'rawId',
  'createdFrom',
];
export const defaultVisibleTaskTableColumns: TaskTableColumnKey[] = ['code', 'intent', 'taskType', 'managementStatus', 'branchStatus', 'runStatus', 'source', 'createdAt', 'updatedAt'];
export const defaultTaskTableColumnWidths: Record<TaskTableColumnKey, number> = {
  code: 112,
  intent: 280,
  taskType: 96,
  managementStatus: 112,
  branchStatus: 128,
  runStatus: 132,
  source: 120,
  updatedAt: 148,
  createdAt: 148,
  template: 144,
  project: 144,
  priority: 112,
  description: 220,
  runtimeSession: 180,
  rawId: 180,
  createdFrom: 144,
};
export const defaultTaskTableEnumSortOrders: TaskTableEnumSortOrders = {
  priority: ['p0', 'p1', 'p2', 'p3', 'p4'],
  managementStatus: ['todo', 'in_development', 'in_testing', 'awaiting_acceptance', 'blocked', 'completed', 'cancelled'],
  runStatus: ['not_started', 'connecting', 'reconnecting', 'running', 'waiting_user', 'waiting_approval', 'paused', 'idle', 'failed', 'legacy_readonly'],
};
const taskBranchStatusSortOrder: TaskBranchStatus[] = ['action_required', 'active', 'pushed', 'merged', 'discarded', 'not_created'];
const preBranchStatusDefaultTaskTableColumnOrder: TaskTableColumnKey[] = [
  'code',
  'intent',
  'managementStatus',
  'runStatus',
  'source',
  'createdAt',
  'updatedAt',
  'template',
  'project',
  'priority',
  'description',
  'runtimeSession',
  'rawId',
  'createdFrom',
];
const preBranchStatusDefaultVisibleTaskTableColumns: TaskTableColumnKey[] = ['code', 'intent', 'managementStatus', 'runStatus', 'source', 'createdAt', 'updatedAt'];
const previousDefaultTaskTableColumns: Array<{ visible: TaskTableColumnKey[]; order: TaskTableColumnKey[] }> = [
  {
    visible: preBranchStatusDefaultVisibleTaskTableColumns,
    order: preBranchStatusDefaultTaskTableColumnOrder,
  },
  {
    visible: ['code', 'intent', 'managementStatus', 'runStatus', 'source', 'updatedAt'],
    order: ['code', 'intent', 'managementStatus', 'runStatus', 'source', 'updatedAt', 'createdAt', 'template', 'project', 'priority', 'description', 'runtimeSession', 'rawId', 'createdFrom'],
  },
];
const taskTableColumnKeySet = new Set<TaskTableColumnKey>(defaultTaskTableColumnOrder);
const legacyTaskTableColumnKeySet = new Set(['nextAction', 'aiExecution', 'signals']);
const legacyTaskTableColumnWidthScale = { compact: 0.78, standard: 1, wide: 1.35 } as const;

export interface TaskWorkspaceFilters {
  query: string;
  status: TaskStatusFilter;
  tag: string;
}

export interface TaskWorkspaceViewModelInput extends TaskWorkspaceFilters {
  tasks: TaskRecord[];
  viewMode?: TaskWorkspaceViewMode;
  expandedTaskIds?: readonly string[];
  selectedTaskId?: string;
  selectedTaskIds?: readonly string[];
  runtimeAiAvailable?: boolean;
  runtimeSessions?: AiRuntimeSession[];
  taskConversations?: Record<string, NativeConversationChoice[]>;
  conversationRunStatuses?: Record<string, TaskAgentRunStatus>;
  managementStatusLabels?: Partial<Record<TaskManagementStatus, string>>;
  managementStatuses?: readonly TaskManagementStatus[];
  completedManagementStatusId?: TaskManagementStatus;
  cancelledManagementStatusId?: TaskManagementStatus;
  runStatusLabels?: Partial<Record<TaskAgentRunStatus, string>>;
  projectName?: string;
  taskTableColumns?: unknown;
  taskTableEnumSortOrders?: unknown;
  appLanguage?: 'zh-CN' | 'en-US';
}

export interface TaskTableCellViewModel {
  primary: string;
  secondary?: string;
  sortValue: string | number | null;
}

export interface TaskRowViewModel {
  id: string;
  task: TaskRecord;
  selected: boolean;
  bulkSelected: boolean;
  action: TaskRowAction;
  runStatusConversationId: string | undefined;
  minHitArea: number;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  cells: Record<TaskTableColumnKey, TaskTableCellViewModel>;
}

export interface TaskBulkStatusEligibility {
  targetStatus: TaskManagementStatus;
  eligibleTaskIds: string[];
  skippedTaskIds: string[];
}

export interface TaskBulkDeleteEligibility {
  eligibleTaskIds: string[];
  skippedTaskIds: string[];
}

export interface TaskWorkspaceViewModel {
  totalCount: number;
  visibleCount: number;
  visibleTaskIds: string[];
  visibleTasks: TaskRecord[];
  selectedVisibleTaskIds: string[];
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  bulkStatusEligibility: Record<TaskManagementStatus, TaskBulkStatusEligibility>;
  bulkDeleteEligibility: TaskBulkDeleteEligibility;
  rows: TaskRowViewModel[];
  emptyState: TaskWorkspaceEmptyState;
  hasActiveFilters: boolean;
  columnPreferences: TaskTableColumnPreferences;
  visibleColumns: TaskTableColumnKey[];
  columnOrder: TaskTableColumnKey[];
}

export function normalizeTaskTableColumnPreferences(input?: unknown): TaskTableColumnPreferences {
  const preferences = isRecord(input) ? input : {};
  const hasLegacyColumns = containsLegacyTaskTableColumnKeys(preferences.visibleColumnKeys) || containsLegacyTaskTableColumnKeys(preferences.columnOrder);
  const visible = normalizeColumnKeys(migrateLegacyTaskTableColumnKeys(preferences.visibleColumnKeys), defaultVisibleTaskTableColumns);
  let visibleWithRequired = Array.from(new Set<TaskTableColumnKey>([...visible, 'code', 'intent']));
  const order = normalizeColumnKeys(migrateLegacyTaskTableColumnKeys(preferences.columnOrder), defaultTaskTableColumnOrder);
  if (hasLegacyColumns) visibleWithRequired = placeStatusColumnsAfterIntent(visibleWithRequired);
  let migratedOrder = hasLegacyColumns ? placeStatusColumnsAfterIntent(order) : order;
  const usesPreviousDefault = previousDefaultTaskTableColumns.some((defaults) => arraysEqual(visibleWithRequired, defaults.visible) && arraysEqual(migratedOrder, defaults.order));
  if (usesPreviousDefault) {
    visibleWithRequired = [...defaultVisibleTaskTableColumns];
    migratedOrder = [...defaultTaskTableColumnOrder];
  } else {
    migratedOrder = insertMissingBranchStatusAfterManagementStatus(migratedOrder);
  }
  const columnWidths = normalizeColumnWidths(preferences.columnWidths);
  const sort = normalizeTaskTableSortState(preferences.sort);
  const normalized: TaskTableColumnPreferences = {
    visibleColumnKeys: visibleWithRequired,
    columnOrder: [...migratedOrder, ...defaultTaskTableColumnOrder.filter((key) => !migratedOrder.includes(key))],
    sort,
  };
  if (columnWidths) normalized.columnWidths = columnWidths;
  return normalized;
}

function insertMissingBranchStatusAfterManagementStatus(keys: TaskTableColumnKey[]): TaskTableColumnKey[] {
  if (keys.includes('branchStatus')) return keys;
  const managementStatusIndex = keys.indexOf('managementStatus');
  const insertIndex = managementStatusIndex >= 0 ? managementStatusIndex + 1 : 0;
  return [...keys.slice(0, insertIndex), 'branchStatus', ...keys.slice(insertIndex)];
}

function arraysEqual(left: readonly TaskTableColumnKey[], right: readonly TaskTableColumnKey[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function containsLegacyTaskTableColumnKeys(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => typeof item === 'string' && legacyTaskTableColumnKeySet.has(item));
}

function placeStatusColumnsAfterIntent(keys: TaskTableColumnKey[]): TaskTableColumnKey[] {
  const withoutStatusColumns = keys.filter((key) => key !== 'managementStatus' && key !== 'runStatus');
  const intentIndex = withoutStatusColumns.indexOf('intent');
  const insertIndex = intentIndex >= 0 ? intentIndex + 1 : 0;
  return [...withoutStatusColumns.slice(0, insertIndex), 'managementStatus', 'runStatus', ...withoutStatusColumns.slice(insertIndex)];
}

function migrateLegacyTaskTableColumnKeys(value: unknown): unknown {
  if (!containsLegacyTaskTableColumnKeys(value)) return value;
  if (!Array.isArray(value)) return value;
  const migrated: string[] = [];
  let insertedStatusColumns = false;
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (legacyTaskTableColumnKeySet.has(item)) {
      if (!insertedStatusColumns) {
        migrated.push('managementStatus', 'runStatus');
        insertedStatusColumns = true;
      }
      continue;
    }
    migrated.push(item);
  }
  return migrated;
}

export function toggleTaskTableColumn(preferences: TaskTableColumnPreferences, columnKey: TaskTableColumnKey, visible: boolean): TaskTableColumnPreferences {
  const normalized = normalizeTaskTableColumnPreferences(preferences);
  if (columnKey === 'code' || columnKey === 'intent') return normalizeTaskTableColumnPreferences(normalized);
  const visibleColumnKeys = visible ? [...normalized.visibleColumnKeys, columnKey] : normalized.visibleColumnKeys.filter((key) => key !== columnKey);
  // 必需列永远由 normalize 补齐，避免用户把任务身份和意图两列配置丢失后无法识别任务。
  return normalizeTaskTableColumnPreferences({
    ...normalized,
    visibleColumnKeys,
  });
}

export function moveTaskTableColumnTo(preferences: TaskTableColumnPreferences, columnKey: TaskTableColumnKey, targetColumnKey: TaskTableColumnKey): TaskTableColumnPreferences {
  const normalized = normalizeTaskTableColumnPreferences(preferences);
  if (columnKey === targetColumnKey) return normalized;
  const sourceIndex = normalized.columnOrder.indexOf(columnKey);
  const targetIndex = normalized.columnOrder.indexOf(targetColumnKey);
  if (sourceIndex < 0 || targetIndex < 0) return normalized;
  const columnOrder = [...normalized.columnOrder];
  const [movedColumn] = columnOrder.splice(sourceIndex, 1);
  columnOrder.splice(targetIndex, 0, movedColumn);
  return normalizeTaskTableColumnPreferences({ ...normalized, columnOrder });
}

export function placeTaskTableColumn(preferences: TaskTableColumnPreferences, columnKey: TaskTableColumnKey, targetColumnKey: TaskTableColumnKey, position: TaskTableColumnDropPosition): TaskTableColumnPreferences {
  const normalized = normalizeTaskTableColumnPreferences(preferences);
  if (columnKey === targetColumnKey) return normalized;
  const columnOrder = normalized.columnOrder.filter((key) => key !== columnKey);
  const targetIndex = columnOrder.indexOf(targetColumnKey);
  if (targetIndex < 0) return normalized;
  columnOrder.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, columnKey);
  return normalizeTaskTableColumnPreferences({ ...normalized, columnOrder });
}

export function setTaskTableColumnWidth(preferences: TaskTableColumnPreferences, columnKey: TaskTableColumnKey, width: TaskTableColumnWidth): TaskTableColumnPreferences {
  const normalized = normalizeTaskTableColumnPreferences(preferences);
  const columnWidths = {
    ...(normalized.columnWidths ?? {}),
    [columnKey]: width,
  };
  // 列宽偏好与显隐、排序共用一份规范化出口；未知字段或未知宽度不会被带入持久化设置。
  return normalizeTaskTableColumnPreferences({
    ...normalized,
    columnWidths,
  });
}

export function cycleTaskTableSort(preferences: TaskTableColumnPreferences, columnKey: TaskTableColumnKey): TaskTableColumnPreferences {
  const normalized = normalizeTaskTableColumnPreferences(preferences);
  const current = normalized.sort;
  let sort: TaskTableSortState;
  if (current.columnKey !== columnKey || current.direction === null) sort = { columnKey, direction: 'asc' };
  else if (current.direction === 'asc') sort = { columnKey, direction: 'desc' };
  else sort = { columnKey: null, direction: null };
  return normalizeTaskTableColumnPreferences({ ...normalized, sort });
}

export function normalizeTaskTableEnumSortOrders(value?: unknown, managementStatuses: readonly TaskManagementStatus[] = taskManagementStatuses): TaskTableEnumSortOrders {
  const input = isRecord(value) ? value : {};
  return {
    priority: normalizeEnumOrder(input.priority, defaultTaskTableEnumSortOrders.priority),
    managementStatus: normalizeEnumOrder(input.managementStatus, managementStatuses.length > 0 ? managementStatuses : defaultTaskTableEnumSortOrders.managementStatus),
    runStatus: normalizeEnumOrder(input.runStatus, defaultTaskTableEnumSortOrders.runStatus),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeColumnKeys(value: unknown, fallback: TaskTableColumnKey[]): TaskTableColumnKey[] {
  if (!Array.isArray(value)) return fallback;
  const seen = new Set<TaskTableColumnKey>();
  for (const item of value) {
    // 只接受当前个人 AI 工作队列列键，团队协作字段会在这里被丢弃。
    if (typeof item === 'string' && taskTableColumnKeySet.has(item as TaskTableColumnKey)) seen.add(item as TaskTableColumnKey);
  }
  return seen.size > 0 ? Array.from(seen) : fallback;
}

function normalizeColumnWidths(value: unknown): Partial<Record<TaskTableColumnKey, TaskTableColumnWidth>> | undefined {
  if (!isRecord(value)) return undefined;
  const normalized: Partial<Record<TaskTableColumnKey, TaskTableColumnWidth>> = {};
  for (const [key, width] of Object.entries(value)) {
    if (!taskTableColumnKeySet.has(key as TaskTableColumnKey)) continue;
    const normalizedWidth = normalizeTaskTableColumnWidth(key as TaskTableColumnKey, width);
    if (normalizedWidth === null) continue;
    normalized[key as TaskTableColumnKey] = normalizedWidth;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeTaskTableColumnWidth(columnKey: TaskTableColumnKey, value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return clampTaskTableColumnWidth(columnKey, value);
  if (typeof value !== 'string' || !(value in legacyTaskTableColumnWidthScale)) return null;
  return clampTaskTableColumnWidth(columnKey, defaultTaskTableColumnWidths[columnKey] * legacyTaskTableColumnWidthScale[value as keyof typeof legacyTaskTableColumnWidthScale]);
}

export function getTaskTableColumnWidthBounds(columnKey: TaskTableColumnKey): { min: number; max: number } {
  if (columnKey === 'intent' || columnKey === 'description') return { min: 140, max: 640 };
  if (columnKey === 'runtimeSession' || columnKey === 'rawId') return { min: 120, max: 640 };
  return { min: 72, max: 640 };
}

export function clampTaskTableColumnWidth(columnKey: TaskTableColumnKey, value: number): number {
  const bounds = getTaskTableColumnWidthBounds(columnKey);
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

function normalizeTaskTableSortState(value: unknown): TaskTableSortState {
  if (!isRecord(value)) return { columnKey: null, direction: null };
  const columnKey = typeof value.columnKey === 'string' && taskTableColumnKeySet.has(value.columnKey as TaskTableColumnKey) ? (value.columnKey as TaskTableColumnKey) : null;
  const direction = value.direction === 'asc' || value.direction === 'desc' ? value.direction : null;
  return columnKey && direction ? { columnKey, direction } : { columnKey: null, direction: null };
}

function normalizeEnumOrder<T extends string>(value: unknown, fallback: readonly T[]): T[] {
  if (!Array.isArray(value)) return [...fallback];
  const allowed = new Set(fallback);
  const normalized = Array.from(new Set(value.filter((item): item is T => typeof item === 'string' && allowed.has(item as T))));
  return [...normalized, ...fallback.filter((item) => !normalized.includes(item))];
}

export function hasActiveTaskFilters(filters: TaskWorkspaceFilters): boolean {
  return Boolean(filters.query.trim() || filters.status || filters.tag.trim());
}

export function filterVisibleTasks(tasks: TaskRecord[], query: string, status: TaskStatusFilter, tag: string, terminalStatusIds: { completed: string; cancelled: string } = { completed: 'completed', cancelled: 'cancelled' }): TaskRecord[] {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedTag = tag.trim().toLowerCase();
  return tasks.filter((task) => {
    const matchesQuery =
      !normalizedQuery ||
      [
        task.taskCode ?? '',
        task.title,
        task.taskType,
        task.description ?? '',
        task.defectCurrentState ?? '',
        task.defectExpectedOutcome ?? '',
        task.defectReproductionSteps ?? '',
        task.optimizationCurrentState ?? '',
        task.optimizationExpectedOutcome ?? '',
        task.id,
        task.createdFrom ?? '',
        task.sourceContextJson ?? '',
        task.priority ?? '',
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    const managementStatus = resolveTaskManagementStatus(task);
    const matchesStatus = status === 'unfinished' ? managementStatus !== terminalStatusIds.completed && managementStatus !== terminalStatusIds.cancelled : !status || managementStatus === status;
    const matchesTag = !normalizedTag || task.tags?.some((item) => item.toLowerCase().includes(normalizedTag));
    return matchesQuery && matchesStatus && matchesTag;
  });
}

export function createTaskWorkspaceViewModel(input: TaskWorkspaceViewModelInput): TaskWorkspaceViewModel {
  const managementStatuses = input.managementStatuses?.length ? [...input.managementStatuses] : taskManagementStatuses;
  const filteredTasks = filterVisibleTasks(input.tasks, input.query, input.status, input.tag, {
    completed: input.completedManagementStatusId ?? 'completed',
    cancelled: input.cancelledManagementStatusId ?? 'cancelled',
  });
  const columnPreferences = normalizeTaskTableColumnPreferences(input.taskTableColumns);
  const enumSortOrders = normalizeTaskTableEnumSortOrders(input.taskTableEnumSortOrders, managementStatuses);
  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const filteredTaskIds = new Set(filteredTasks.map((task) => task.id));
  const hierarchyVisibleTaskIds = new Set(filteredTaskIds);
  if ((input.viewMode ?? 'hierarchy') === 'hierarchy') {
    for (const task of filteredTasks) {
      let parentTaskId = task.parentTaskId ?? null;
      const visited = new Set<string>();
      while (parentTaskId && !visited.has(parentTaskId)) {
        visited.add(parentTaskId);
        const parent = taskById.get(parentTaskId);
        if (!parent) break;
        hierarchyVisibleTaskIds.add(parent.id);
        parentTaskId = parent.parentTaskId ?? null;
      }
    }
  }
  const candidateTasks = (input.viewMode ?? 'hierarchy') === 'hierarchy' ? input.tasks.filter((task) => hierarchyVisibleTaskIds.has(task.id)) : filteredTasks;
  const unsortedRows: TaskRowViewModel[] = candidateTasks.map((task) => {
    const taskConversations = input.taskConversations?.[task.id] ?? [];
    return {
      id: task.id,
      task,
      selected: task.id === input.selectedTaskId,
      bulkSelected: false,
      action: 'open-detail',
      runStatusConversationId: resolveTaskAgentRunStatusConversation(taskConversations)?.id,
      minHitArea: 44,
      depth: 0,
      hasChildren: false,
      expanded: false,
      cells: buildTaskTableCells(task, input.runtimeSessions ?? [], input.projectName, taskConversations, input.conversationRunStatuses ?? {}, input.managementStatusLabels, input.runStatusLabels, input.appLanguage ?? 'zh-CN'),
    };
  });
  const rows =
    (input.viewMode ?? 'hierarchy') === 'hierarchy'
      ? flattenHierarchyRows(unsortedRows, filteredTaskIds, input.expandedTaskIds ?? [], hasActiveTaskFilters(input), columnPreferences.sort, enumSortOrders, input.appLanguage ?? 'zh-CN')
      : sortTaskRows(unsortedRows, columnPreferences.sort, enumSortOrders, input.appLanguage ?? 'zh-CN');
  const visibleTasks = rows.map((row) => row.task);
  const visibleTaskIds = rows.map((row) => row.id);
  const selectedTaskIdSet = new Set(input.selectedTaskIds ?? []);
  const selectedVisibleTasks = visibleTasks.filter((task) => selectedTaskIdSet.has(task.id));
  const selectedVisibleTaskIds = selectedVisibleTasks.map((task) => task.id);
  const hasActiveFilters = hasActiveTaskFilters(input);
  const emptyState: TaskWorkspaceEmptyState = input.tasks.length === 0 ? 'empty' : visibleTasks.length === 0 && hasActiveFilters ? 'no-results' : undefined;
  const visibleColumnSet = new Set(columnPreferences.visibleColumnKeys);
  const bulkStatusEligibility = buildBulkStatusEligibility(selectedVisibleTasks, managementStatuses);
  for (const row of rows) row.bulkSelected = selectedTaskIdSet.has(row.id);
  return {
    totalCount: input.tasks.length,
    visibleCount: visibleTasks.length,
    visibleTaskIds,
    visibleTasks,
    selectedVisibleTaskIds,
    allVisibleSelected: visibleTaskIds.length > 0 && selectedVisibleTaskIds.length === visibleTaskIds.length,
    someVisibleSelected: selectedVisibleTaskIds.length > 0,
    bulkStatusEligibility,
    bulkDeleteEligibility: buildBulkDeleteEligibility(selectedVisibleTasks),
    rows,
    emptyState,
    hasActiveFilters,
    columnPreferences,
    visibleColumns: columnPreferences.columnOrder.filter((columnKey) => visibleColumnSet.has(columnKey)),
    columnOrder: columnPreferences.columnOrder,
  };
}

function flattenHierarchyRows(
  rows: TaskRowViewModel[],
  matchedTaskIds: Set<string>,
  expandedTaskIds: readonly string[],
  hasFilters: boolean,
  sort: TaskTableSortState,
  enumSortOrders: TaskTableEnumSortOrders,
  language: 'zh-CN' | 'en-US',
): TaskRowViewModel[] {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const childrenByParentId = new Map<string, TaskRowViewModel[]>();
  const roots: TaskRowViewModel[] = [];
  for (const row of rows) {
    const parentTaskId = row.task.parentTaskId;
    if (!parentTaskId || !rowById.has(parentTaskId)) roots.push(row);
    else childrenByParentId.set(parentTaskId, [...(childrenByParentId.get(parentTaskId) ?? []), row]);
  }
  const forcedExpandedIds = new Set<string>();
  if (hasFilters) {
    for (const matchedTaskId of matchedTaskIds) {
      let parentTaskId = rowById.get(matchedTaskId)?.task.parentTaskId ?? null;
      while (parentTaskId && rowById.has(parentTaskId)) {
        forcedExpandedIds.add(parentTaskId);
        parentTaskId = rowById.get(parentTaskId)?.task.parentTaskId ?? null;
      }
    }
  }
  const expandedIdSet = new Set(expandedTaskIds);
  const flattened: TaskRowViewModel[] = [];
  function appendSiblings(siblings: TaskRowViewModel[], depth: number): void {
    for (const row of sortTaskRows(siblings, sort, enumSortOrders, language)) {
      const children = childrenByParentId.get(row.id) ?? [];
      row.depth = Math.min(depth, 2);
      row.hasChildren = children.length > 0;
      row.expanded = row.hasChildren && (expandedIdSet.has(row.id) || forcedExpandedIds.has(row.id));
      flattened.push(row);
      if (row.expanded) appendSiblings(children, depth + 1);
    }
  }
  appendSiblings(roots, 0);
  return flattened;
}

function sortTaskRows(rows: TaskRowViewModel[], sort: TaskTableSortState, enumSortOrders: TaskTableEnumSortOrders, language: 'zh-CN' | 'en-US'): TaskRowViewModel[] {
  if (!sort.columnKey || !sort.direction) return rows;
  const sourceIndexes = new Map(rows.map((row, index) => [row.id, index]));
  const enumOrder = resolveTaskTableEnumOrder(sort.columnKey, enumSortOrders);
  const collator = new Intl.Collator(language, { numeric: true, sensitivity: 'base' });
  return [...rows].sort((left, right) => {
    const leftValue = left.cells[sort.columnKey!].sortValue;
    const rightValue = right.cells[sort.columnKey!].sortValue;
    const leftEmpty = leftValue === null || leftValue === '';
    const rightEmpty = rightValue === null || rightValue === '';
    // 空值与未知枚举值在升降序中都固定置底，避免切换方向时把缺失数据推到最前。
    if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
    if (leftEmpty && rightEmpty) return (sourceIndexes.get(left.id) ?? 0) - (sourceIndexes.get(right.id) ?? 0);
    let compared = 0;
    if (enumOrder && typeof leftValue === 'string' && typeof rightValue === 'string') {
      const leftRank = enumOrder.indexOf(leftValue);
      const rightRank = enumOrder.indexOf(rightValue);
      const leftUnknown = leftRank < 0;
      const rightUnknown = rightRank < 0;
      if (leftUnknown !== rightUnknown) return leftUnknown ? 1 : -1;
      compared = leftUnknown && rightUnknown ? collator.compare(leftValue, rightValue) : leftRank - rightRank;
    } else if (typeof leftValue === 'number' && typeof rightValue === 'number') {
      compared = leftValue - rightValue;
    } else {
      compared = collator.compare(String(leftValue), String(rightValue));
    }
    if (compared === 0) return (sourceIndexes.get(left.id) ?? 0) - (sourceIndexes.get(right.id) ?? 0);
    return sort.direction === 'asc' ? compared : -compared;
  });
}

function resolveTaskTableEnumOrder(columnKey: TaskTableColumnKey, orders: TaskTableEnumSortOrders): readonly string[] | undefined {
  if (columnKey === 'taskType') return taskTypes;
  if (columnKey === 'priority') return orders.priority;
  if (columnKey === 'managementStatus') return orders.managementStatus;
  if (columnKey === 'branchStatus') return taskBranchStatusSortOrder;
  if (columnKey === 'runStatus') return orders.runStatus;
  return undefined;
}

function buildBulkStatusEligibility(tasks: TaskRecord[], managementStatuses: readonly TaskManagementStatus[]): Record<TaskManagementStatus, TaskBulkStatusEligibility> {
  return managementStatuses.reduce<Record<TaskManagementStatus, TaskBulkStatusEligibility>>(
    (eligibility, targetStatus) => {
      const eligibleTaskIds: string[] = [];
      const skippedTaskIds: string[] = [];
      for (const task of tasks) {
        // 项目管理阶段与 Agent 状态解耦；除当前值外均可由用户显式调整。
        if (resolveTaskManagementStatus(task) !== targetStatus) eligibleTaskIds.push(task.id);
        else skippedTaskIds.push(task.id);
      }
      eligibility[targetStatus] = { targetStatus, eligibleTaskIds, skippedTaskIds };
      return eligibility;
    },
    {} as Record<TaskManagementStatus, TaskBulkStatusEligibility>,
  );
}

function buildBulkDeleteEligibility(tasks: TaskRecord[]): TaskBulkDeleteEligibility {
  const eligibleTaskIds: string[] = [];
  const skippedTaskIds: string[] = [];
  for (const task of tasks) {
    // 删除属于危险动作，运行中或等待用户确认的任务默认跳过，避免误删正在执行的本地证据链。
    if (task.status === 'running' || task.status === 'waiting_confirmation') skippedTaskIds.push(task.id);
    else eligibleTaskIds.push(task.id);
  }
  return { eligibleTaskIds, skippedTaskIds };
}

export function formatTaskSource(task: TaskRecord, labels?: TaskSourceLabels): string {
  const context = parseTaskSourceContext(task.sourceContextJson);
  const contextType = typeof context.type === 'string' ? normalizeSourceType(context.type) : undefined;
  const sourceType = normalizeSourceType(task.createdFrom) ?? contextType;
  const mapped = sourceType ? formatTaskSourceType(sourceType, labels) : undefined;
  if (mapped) return mapped;
  if (contextType) return contextType;
  return labels?.manual ?? '手动创建';
}

function normalizeSourceType(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function formatTaskUpdatedAt(value?: string, missingLabel = '未记录', options: { timeZone?: string } = {}): string {
  const normalized = value?.trim();
  if (!normalized) return missingLabel;
  const date = new Date(normalized);
  if (!Number.isNaN(date.getTime())) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
        timeZone: options.timeZone,
      }).formatToParts(date);
      const getPart = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
      const year = getPart('year');
      const month = getPart('month');
      const day = getPart('day');
      const hour = getPart('hour');
      const minute = getPart('minute');
      const second = getPart('second');
      if (year && month && day && hour && minute && second) return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
    } catch {
      // Intl 在极少数无效 timeZone 输入下会抛错；此时回退到原始 ISO 摘要，避免空白时间。
    }
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/u.exec(normalized);
  return match ? `${match[1]} ${match[2]}` : normalized;
}

export function findLinkedRuntimeSession(task: TaskRecord, runtimeSessions: AiRuntimeSession[] = []): AiRuntimeSession | undefined {
  const context = parseTaskSourceContext(task.sourceContextJson);
  const sourceSessionId = typeof context.sessionId === 'string' && context.sessionId.trim() ? context.sessionId : undefined;
  // 只接受真实 taskId 或来源上下文 sessionId 作为证据链，避免抽屉把无关 Runtime 会话误贴到任务上。
  return runtimeSessions.find((session) => session.taskId === task.id) ?? (sourceSessionId ? runtimeSessions.find((session) => session.id === sourceSessionId) : undefined);
}

export function formatRuntimeSessionStatus(session: AiRuntimeSession | undefined, labels?: Partial<Record<AiRuntimeSessionStatus, string>>, missingLabel = '尚未开始运行'): string {
  if (!session) return missingLabel;
  const defaultLabels: Record<AiRuntimeSessionStatus, string> = {
    running: '运行中',
    exited: '已退出',
    failed: '已失败',
    stopped: '已停止',
    orphan_detected: '运行连接已丢失',
    lost: '已丢失',
  };
  return labels?.[session.status] ?? defaultLabels[session.status];
}

function buildTaskTableCells(
  task: TaskRecord,
  runtimeSessions: AiRuntimeSession[],
  projectName: string | undefined,
  conversations: NativeConversationChoice[],
  conversationRunStatuses: Record<string, TaskAgentRunStatus>,
  managementStatusLabels?: Partial<Record<TaskManagementStatus, string>>,
  runStatusLabels?: Partial<Record<TaskAgentRunStatus, string>>,
  language: 'zh-CN' | 'en-US' = 'zh-CN',
): Record<TaskTableColumnKey, TaskTableCellViewModel> {
  const taskRuntimeSession = findLinkedRuntimeSession(task, runtimeSessions);
  // 表格缺省说明使用当前语言，不改写任务数据。
  const zh = language === 'zh-CN';
  const displayProjectName = projectName?.trim() || (zh ? '当前项目' : 'Current project');
  // 来源名在表格入口翻译；来源标识继续保留供排序与记录使用。
  const sourceLabels = zh ? undefined : { graph_node: 'Graph node', graph_view: 'Code graph', runtime_session: 'Run', template: 'Task template', graph_question: 'Graph question', manual: 'Created manually', user: 'Created manually' };
  const runStatus = resolveTaskAgentRunStatus(conversations, conversationRunStatuses);
  const managementStatus = resolveTaskManagementStatus(task);
  const branchStatus = resolveTaskBranchStatus(conversations);
  const activeContent =
    task.taskType === 'defect'
      ? [task.defectCurrentState, task.defectExpectedOutcome, task.defectReproductionSteps].find((value) => value?.trim())
      : task.taskType === 'optimization'
        ? [task.optimizationCurrentState, task.optimizationExpectedOutcome].find((value) => value?.trim())
        : task.description;
  return {
    code: { primary: task.taskCode || task.id, sortValue: task.taskCode || task.id },
    intent: { primary: task.title, sortValue: task.title },
    taskType: { primary: formatTaskType(task.taskType, language), sortValue: task.taskType },
    managementStatus: {
      primary: formatTaskManagementStatus(managementStatus, managementStatusLabels),
      sortValue: managementStatus,
    },
    branchStatus: {
      primary: formatTaskBranchStatus(branchStatus, language !== 'zh-CN'),
      sortValue: branchStatus,
    },
    runStatus: { primary: formatTaskAgentRunStatus(runStatus, runStatusLabels), sortValue: runStatus },
    source: { primary: formatTaskSource(task, sourceLabels), sortValue: formatTaskSource(task, sourceLabels) },
    updatedAt: { primary: formatTaskUpdatedAt(task.updatedAt, zh ? '未记录' : 'Not recorded'), sortValue: parseTaskDateSortValue(task.updatedAt) },
    createdAt: { primary: formatTaskUpdatedAt(task.createdAt, zh ? '未记录' : 'Not recorded'), sortValue: parseTaskDateSortValue(task.createdAt) },
    template: { primary: task.templateId ?? (zh ? '未绑定模板' : 'No template'), sortValue: task.templateId ?? null },
    project: { primary: displayProjectName, sortValue: displayProjectName },
    priority: { primary: task.priority ?? (zh ? '未设置' : 'Not set'), sortValue: task.priority ?? null },
    description: { primary: activeContent?.trim() || (language === 'zh-CN' ? '无内容' : 'No content'), sortValue: activeContent?.trim() || null },
    runtimeSession: {
      primary: taskRuntimeSession?.id ?? (zh ? '无运行会话' : 'No run'),
      secondary: taskRuntimeSession
        ? formatRuntimeSessionStatus(taskRuntimeSession, zh ? undefined : { running: 'Running', exited: 'Exited', failed: 'Failed', stopped: 'Stopped', orphan_detected: 'Connection lost', lost: 'Lost' })
        : undefined,
      sortValue: taskRuntimeSession?.id ?? null,
    },
    rawId: { primary: task.id, sortValue: task.id },
    createdFrom: { primary: task.createdFrom ?? 'manual', sortValue: task.createdFrom ?? 'manual' },
  };
}

export function formatTaskType(taskType: TaskType, language: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  const labels: Record<TaskType, [string, string]> = {
    requirement: ['需求', 'Requirement'],
    defect: ['缺陷', 'Defect'],
    optimization: ['优化', 'Optimization'],
  };
  return labels[taskType]?.[language === 'zh-CN' ? 0 : 1] ?? taskType;
}

export function resolveTaskBranchStatus(conversations: NativeConversationChoice[]): TaskBranchStatus {
  const workspaces = Array.from(
    new Map(
      conversations
        .map((conversation) => conversation.workspace)
        .filter((workspace): workspace is NonNullable<NativeConversationChoice['workspace']> => Boolean(workspace))
        .map((workspace) => [workspace.id, workspace]),
    ).values(),
  );
  if (workspaces.length === 0) return 'not_created';
  if (workspaces.some((workspace) => workspace.state === 'failed')) return 'action_required';
  if (workspaces.some((workspace) => workspace.state === 'ready')) return 'active';
  if (workspaces.some((workspace) => workspace.state === 'reclaimed')) return 'pushed';
  if (workspaces.some((workspace) => workspace.state === 'merged')) return 'merged';
  return 'discarded';
}

function formatTaskBranchStatus(status: TaskBranchStatus, english: boolean): string {
  const labels: Record<TaskBranchStatus, [string, string]> = {
    action_required: ['Git 待处理', 'Git action needed'],
    active: ['开发中', 'In development'],
    pushed: ['已推送，待合入', 'Pushed, awaiting merge'],
    merged: ['已合入', 'Merged'],
    discarded: ['已放弃', 'Discarded'],
    not_created: ['未创建', 'Not created'],
  };
  return labels[status][english ? 1 : 0];
}

function parseTaskDateSortValue(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function taskAgentRunStatusFromSession(state: NativeSessionState): TaskAgentRunStatus {
  if (state.conversationState === 'turn_failed') return 'failed';
  if (state.queue?.state.type === 'paused' && state.queue.state.reason === 'recovery_required') return 'paused';
  if (state.planImplementationRequests.some((request) => request.status === 'pending')) return 'waiting_user';
  if (state.queue?.state.type === 'paused') return 'paused';
  if (state.conversationState === 'waiting_user_input') return 'waiting_user';
  if (state.conversationState === 'waiting_approval') return 'waiting_approval';
  if (state.conversationState === 'legacy_readonly') return 'legacy_readonly';
  if (state.conversationState === 'native_idle' || state.conversationState === 'native_loading') return 'idle';
  return 'running';
}

export function taskAgentRunStatusFromConversation(conversation: Pick<NativeConversationChoice, 'status' | 'stage' | 'transportKind' | 'providerState' | 'pendingRequestKind' | 'taskRunStatus'> & { readOnly?: boolean }): TaskAgentRunStatus {
  if (conversation.taskRunStatus) return conversation.taskRunStatus;
  if (conversation.transportKind !== 'codex_native') return 'legacy_readonly';
  const providerState = `${conversation.providerState ?? ''}`.toLowerCase();
  const recordState = conversation.status.toLowerCase();
  if (providerState.includes('failed') || providerState.includes('error') || recordState.includes('failed') || recordState.includes('error')) return 'failed';
  if (conversation.stage === 'waiting_user') return 'waiting_user';
  if (conversation.stage === 'waiting_approval') return 'waiting_approval';
  if (providerState.includes('paused') || recordState.includes('paused')) return 'paused';
  if (conversation.pendingRequestKind === 'user_input' || providerState.includes('user_input') || providerState.includes('user input')) return 'waiting_user';
  if (conversation.pendingRequestKind === 'approval' || providerState.includes('approval') || providerState.includes('waiting')) return 'waiting_approval';
  return 'idle';
}

export function resolveTaskAgentRunStatus(conversations: NativeConversationChoice[], liveStatuses: Record<string, TaskAgentRunStatus>): TaskAgentRunStatus {
  const latest = resolveTaskAgentRunStatusConversation(conversations);
  if (!latest) return 'not_started';
  const liveStatus = liveStatuses[latest.id];
  if (liveStatus) return liveStatus;
  return taskAgentRunStatusFromConversation(latest);
}

export function resolveTaskAgentRunStatusConversation(conversations: NativeConversationChoice[]): NativeConversationChoice | undefined {
  if (conversations.length === 0) return undefined;
  return [...conversations].sort(compareConversationStageUpdatedDesc)[0];
}

export function formatTaskManagementStatus(status: TaskManagementStatus, labels?: Partial<Record<TaskManagementStatus, string>>): string {
  const defaultLabels: Record<string, string> = {
    todo: '待开始',
    in_development: '开发中',
    in_testing: '测试中',
    awaiting_acceptance: '待验收',
    blocked: '已阻塞',
    completed: '已完成',
    cancelled: '已取消',
  };
  return labels?.[status] ?? defaultLabels[status] ?? status;
}

export function resolveTaskManagementStatus(task: Pick<TaskRecord, 'managementStatus' | 'status'>): TaskManagementStatus {
  if (task.managementStatus) return task.managementStatus;
  if (task.status === 'completed') return 'completed';
  if (task.status === 'cancelled') return 'cancelled';
  if (task.status === 'running' || task.status === 'paused' || task.status === 'waiting_confirmation' || task.status === 'failed') return 'in_development';
  return 'todo';
}

export function formatTaskAgentRunStatus(status: TaskAgentRunStatus, labels?: Partial<Record<TaskAgentRunStatus, string>>): string {
  const defaultLabels: Record<TaskAgentRunStatus, string> = {
    not_started: '未启动',
    connecting: '正在连接',
    reconnecting: '正在重连',
    running: '运行中',
    waiting_user: '等待用户回复',
    waiting_approval: '等待授权',
    paused: '已暂停',
    idle: '等待新指令',
    failed: '运行失败',
    legacy_readonly: '旧会话只读',
  };
  return labels?.[status] ?? defaultLabels[status];
}

function formatTaskSourceType(value: string, labels?: TaskSourceLabels): string | undefined {
  const customLabel = labels?.[value];
  if (customLabel) return customLabel;
  const sourceLabels: Record<string, string> = {
    graph_node: '图谱节点',
    graph_view: '代码图谱',
    runtime_session: '运行会话',
    template: '任务模板',
    graph_question: '图谱问答',
    manual: '手动创建',
    user: '手动创建',
  };
  // 来源可能来自 createdFrom 或 sourceContextJson.type，统一映射后再进入可访问表格文本，避免 raw enum 被读屏直接读出。
  return sourceLabels[value];
}

export function parseTaskSourceContext(value?: string): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Zeus 自己生成的任务事件按类型展示，不修改保存的历史或用户正文。 */
const taskEventCopy: Readonly<Record<string, readonly [string, string]>> = {
  'task.stage.attempt.started': ['任务阶段已开始', 'Task stage started'],
  'task.git_integration.ai_accepted': ['正在为 AI 准备冲突处理目录', 'Preparing conflict resolution for the AI'],
  'task.model_push.started': ['任务已加入 AI 对话', 'Task added to an AI conversation'],
  'task.model_push.turn_not_started': ['对话已创建，AI 尚未开始处理', 'Conversation created; AI processing has not started'],
  'task.conversation.worktree.rehydrated': ['任务工作目录已恢复', 'Task working folder restored'],
  'task.work_item.automation_created': ['自动化已创建工作项', 'Automation created a work item'],
  'task.digital_employee.started': ['数字员工已开始处理任务', 'Digital employee started the task'],
  'task.digital_employee.stage_output_ready': ['阶段方案已生成，等待确认', 'Stage plan ready for review'],
  'task.digital_employee.delivery_started': ['已开始执行确认过的交付操作', 'Approved delivery actions started'],
  'task.digital_employee.delivered': ['数字员工已完成工作', 'Digital employee finished the work'],
  'task.digital_employee.failed': ['数字员工暂时无法继续，请查看工作项原因', 'Digital employee cannot continue; check the work item’s reason'],
  'task.digital_employee.retried': ['工作已重新排队', 'Work queued again'],
  'task.digital_employee.cancelled': ['数字员工工作已取消', 'Digital employee work cancelled'],
  'task.digital_employee.legacy_adopted': ['已从旧任务接续工作', 'Work continued from an earlier task'],
  'task.digital_employee.handoff.created': ['任务阶段已交接', 'Task stage handed over'],
  'task.digital_employee.stage_retry.created': ['失败阶段已重新指派', 'Failed stage reassigned'],
  'task.digital_employee.rework.created': ['阶段修改已重新指派', 'Stage rework assigned'],
  'task.digital_employee.collaboration.finalized': ['协作结果已确认，准备交付', 'Collaboration reviewed; preparing delivery'],
  'task.environment.created': ['已关联本地任务分支', 'Local task branch linked'],
  'task.terminal_resources.cleaned': ['任务结束后的工作目录已清理', 'Working folders cleaned up after task completion'],
  'task.git_workspace.committed': ['任务分支已提交', 'Task branch committed'],
  'task.git_workspace.pushed': ['任务分支已推送', 'Task branch pushed'],
  'task.git_workspace.sessions_stopped': ['任务分支上的会话已停止', 'Conversations on the task branch stopped'],
  'task.git_workspace.reclaimed': ['任务独立工作目录已移除', 'Task’s separate working folder removed'],
  'task.git_workspace.discarded': ['任务本地分支已放弃', 'Local task branch discarded'],
  'task.git_workspace.refresh_conflicted': ['更新分支后出现新冲突', 'New conflicts found after updating the branch'],
  'task.git_integration.conflicted': ['合入任务分支前需要处理冲突', 'Conflicts must be resolved before merging the task branch'],
  'task.git_integration.rebuilt_for_confirmation': ['分支已更新，请重新确认合入内容', 'Branch updated; review the merge again'],
  'task.git_integration.local_sync_pending': ['合入结果尚未写入本地来源分支', 'Merge result has not been applied to the local source branch'],
  'task.git_integration.merged': ['任务分支已合入来源分支', 'Task branch merged into its source'],
  'task.git_integration.source_pushed': ['来源分支已推送', 'Source branch pushed'],
  'task.git_integration.ai_started': ['AI 已开始处理冲突', 'AI conflict resolution started'],
  'task.git_integration.ai_prepare_failed': ['冲突处理未能开始，请查看会话中的原因', 'Conflict resolution could not start; see the conversation for the reason'],
  'task.git_integration.ai_merged': ['AI 已完成本地合入', 'AI completed the local merge'],
  'task.git_integration.ai_failed': ['AI 未能完成本地合入，请查看会话中的原因', 'AI could not finish the local merge; see the conversation for the reason'],
  'task.management_status.migrated': ['任务状态设置已更新', 'Task status settings updated'],
  'telegram.runtime.summary.sent': ['运行进度已发送到 Telegram', 'Progress sent to Telegram'],
  'telegram.runtime.summary.failed': ['未能向 Telegram 发送运行进度', 'Progress could not be sent to Telegram'],
  'runtime.session.recovered': ['运行状态已重新读取', 'Run state loaded again'],
  'telegram.run': ['已从 Telegram 启动任务', 'Task started from Telegram'],
  'telegram.stop': ['已从 Telegram 停止任务', 'Task stopped from Telegram'],
  'telegram.continue': ['已从 Telegram 继续任务', 'Task continued from Telegram'],
  'task.runtime.reconnect': ['任务已重新连接', 'Task reconnected'],
  'task.created.from_runtime_session': ['已从运行记录创建任务', 'Task created from a run'],
  'task.runtime.queued': ['任务等待 AI 处理', 'Task waiting for AI processing'],
  'task.management_status.changed': ['任务状态已更新', 'Task status updated'],
  'task.workflow.initialized': ['任务阶段已启用', 'Task stages enabled'],
  'task.stage.configured': ['任务阶段设置已更新', 'Task stage settings updated'],
  'task.stage.deliverable.accepted': ['阶段交付物已通过验收', 'Stage deliverable accepted'],
  'task.stage.deliverable.changes_requested': ['阶段交付物需要修改', 'Changes requested to the stage deliverable'],
  'task.stage.skipped': ['任务阶段已跳过', 'Task stage skipped'],
  'task.work_item.created': ['工作项已创建', 'Work item created'],
  'task.work_deliverable.submitted': ['数字员工已提交交付物', 'Digital employee submitted a deliverable'],
  'task.work_command.started': ['数字员工已启动项目命令', 'Digital employee started a project command'],
  'task.work_command.succeeded': ['数字员工的命令已完成', 'Digital employee’s command completed'],
  'task.work_deliverable.accepted': ['数字员工交付物已通过验收', 'Digital employee’s deliverable accepted'],
  'task.work_deliverable.changes_requested': ['数字员工交付物需要修改', 'Changes requested to the digital employee’s deliverable'],
  'task.created': ['任务已创建', 'Task created'],
  'task.runtime.retry': ['任务已重新运行', 'Task run again'],
  'task.created.from_template': ['已从模板创建任务', 'Task created from a template'],
  'task.created.from_graph_question': ['已从图谱问答创建任务', 'Task created from a graph conversation'],
  'task.created.from_graph_node': ['已从图谱节点创建任务', 'Task created from a graph node'],
  'task.created.from_graph_view': ['已从图谱视图创建任务', 'Task created from a graph view'],
  'task.linked_graph_node': ['任务已关联图谱节点', 'Task linked to a graph node'],
  'telegram.notification.sent': ['Telegram 通知已发送', 'Telegram notification sent'],
  'telegram.notification.failed': ['尚未确认 Telegram 通知是否送达', 'Telegram notification delivery is unconfirmed'],
  'task.board.moved': ['任务已在看板中移动', 'Task moved on the board'],
  'task.archived': ['任务已归档', 'Task archived'],
  'task.restored': ['任务已恢复', 'Task restored'],
  'task.updated': ['任务内容已更新', 'Task content updated'],
  'task.tags.updated': ['任务标签已更新', 'Task tags updated'],
  'task.relationships.updated': ['任务关系已更新', 'Task relationships updated'],
  'task.deleted': ['任务已删除', 'Task deleted'],
};

/** 未识别事件保留原始标题，避免改写用户或第三方生成的内容。 */
export function formatTaskEventTitle(event: { eventType: string; title: string }, language: 'zh-CN' | 'en-US'): string {
  return taskEventCopy[event.eventType]?.[language === 'zh-CN' ? 0 : 1] ?? event.title;
}
