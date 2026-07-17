import type { AiRuntimeSession, AiRuntimeSessionStatus, TaskRecord, TaskStatus, TaskTableColumnKey, TaskTableColumnPreferences, TaskTableColumnWidth } from '../apiClient.js';

export type TaskSortKey = 'createdAt' | 'updatedAt' | 'title' | 'status';
export type TaskWorkspaceEmptyState = 'empty' | 'no-results' | undefined;
export type TaskRowAction = 'open-detail';
export type TaskTableColumnMoveDirection = 'up' | 'down';
export type TaskNextActionLabels = Partial<Record<TaskStatus, string>>;
export type TaskSourceLabels = Partial<Record<string, string>>;

const taskStatuses: TaskStatus[] = ['draft', 'ready', 'running', 'paused', 'waiting_confirmation', 'completed', 'failed', 'cancelled'];
const allowedTaskStatusTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ['ready', 'cancelled'],
  // ready -> running 会创建 Runtime 会话，必须逐任务进入显式 conversation chooser，不能作为批量状态迁移。
  ready: ['cancelled'],
  running: ['paused', 'waiting_confirmation', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  waiting_confirmation: ['running', 'cancelled', 'failed'],
  completed: [],
  failed: ['ready'],
  cancelled: ['ready'],
};

export const defaultTaskTableColumnOrder: TaskTableColumnKey[] = [
  'code',
  'intent',
  'nextAction',
  'aiExecution',
  'source',
  'signals',
  'updatedAt',
  'createdAt',
  'template',
  'project',
  'priority',
  'description',
  'runtimeSession',
  'rawId',
  'createdFrom',
];
export const defaultVisibleTaskTableColumns: TaskTableColumnKey[] = ['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt'];
const taskTableColumnKeySet = new Set<TaskTableColumnKey>(defaultTaskTableColumnOrder);
const taskTableColumnWidthSet = new Set<TaskTableColumnWidth>(['compact', 'standard', 'wide']);

export interface TaskWorkspaceFilters {
  query: string;
  status: TaskStatus | '';
  tag: string;
  sortBy: TaskSortKey;
}

export interface TaskWorkspaceViewModelInput extends TaskWorkspaceFilters {
  tasks: TaskRecord[];
  selectedTaskId?: string;
  selectedTaskIds?: readonly string[];
  runtimeAiAvailable?: boolean;
  runtimeSessions?: AiRuntimeSession[];
  projectName?: string;
  taskTableColumns?: unknown;
}

export interface TaskTableCellViewModel {
  primary: string;
  secondary?: string;
}

export interface TaskRowViewModel {
  id: string;
  task: TaskRecord;
  selected: boolean;
  bulkSelected: boolean;
  action: TaskRowAction;
  minHitArea: number;
  cells: Record<TaskTableColumnKey, TaskTableCellViewModel>;
}

export interface TaskBulkStatusEligibility {
  targetStatus: TaskStatus;
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
  bulkStatusEligibility: Record<TaskStatus, TaskBulkStatusEligibility>;
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
  const visible = normalizeColumnKeys(preferences.visibleColumnKeys, defaultVisibleTaskTableColumns);
  const visibleWithRequired = Array.from(new Set<TaskTableColumnKey>([...visible, 'code', 'intent']));
  const order = normalizeColumnKeys(preferences.columnOrder, defaultTaskTableColumnOrder);
  const columnWidths = normalizeColumnWidths(preferences.columnWidths);
  const normalized: TaskTableColumnPreferences = {
    visibleColumnKeys: visibleWithRequired,
    columnOrder: [...order, ...defaultTaskTableColumnOrder.filter((key) => !order.includes(key))],
  };
  if (columnWidths) normalized.columnWidths = columnWidths;
  return normalized;
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

export function moveTaskTableColumn(preferences: TaskTableColumnPreferences, columnKey: TaskTableColumnKey, direction: TaskTableColumnMoveDirection): TaskTableColumnPreferences {
  const normalized = normalizeTaskTableColumnPreferences(preferences);
  const currentIndex = normalized.columnOrder.indexOf(columnKey);
  const nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= normalized.columnOrder.length) return normalized;
  const columnOrder = [...normalized.columnOrder];
  [columnOrder[currentIndex], columnOrder[nextIndex]] = [columnOrder[nextIndex], columnOrder[currentIndex]];
  // 列顺序只在受支持字段集合内交换；再走 normalize 可确保 code/intent 仍可见，且 owner/assignee 不会被带回。
  return normalizeTaskTableColumnPreferences({
    ...normalized,
    columnOrder,
  });
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
    if (typeof width !== 'string' || !taskTableColumnWidthSet.has(width as TaskTableColumnWidth)) continue;
    normalized[key as TaskTableColumnKey] = width as TaskTableColumnWidth;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function hasActiveTaskFilters(filters: TaskWorkspaceFilters): boolean {
  return Boolean(filters.query.trim() || filters.status || filters.tag.trim());
}

export function filterVisibleTasks(tasks: TaskRecord[], query: string, status: TaskStatus | '', tag: string, sortBy: TaskSortKey): TaskRecord[] {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedTag = tag.trim().toLowerCase();
  const filtered = tasks.filter((task) => {
    const matchesQuery =
      !normalizedQuery || [task.taskCode ?? '', task.title, task.description ?? '', task.id, task.createdFrom ?? '', task.sourceContextJson ?? '', task.priority ?? ''].some((value) => value.toLowerCase().includes(normalizedQuery));
    const matchesStatus = !status || task.status === status;
    const matchesTag = !normalizedTag || task.tags?.some((item) => item.toLowerCase().includes(normalizedTag));
    return matchesQuery && matchesStatus && matchesTag;
  });
  return [...filtered].sort((left, right) => {
    if (sortBy === 'title') return left.title.localeCompare(right.title);
    if (sortBy === 'status') return left.status.localeCompare(right.status);
    if (sortBy === 'createdAt') return (left.createdAt ?? left.id).localeCompare(right.createdAt ?? right.id);
    if (sortBy === 'updatedAt') return (left.updatedAt ?? left.id).localeCompare(right.updatedAt ?? right.id);
    return left.id.localeCompare(right.id);
  });
}

export function createTaskWorkspaceViewModel(input: TaskWorkspaceViewModelInput): TaskWorkspaceViewModel {
  const visibleTasks = filterVisibleTasks(input.tasks, input.query, input.status, input.tag, input.sortBy);
  const visibleTaskIds = visibleTasks.map((task) => task.id);
  const selectedTaskIdSet = new Set(input.selectedTaskIds ?? []);
  const selectedVisibleTasks = visibleTasks.filter((task) => selectedTaskIdSet.has(task.id));
  const selectedVisibleTaskIds = selectedVisibleTasks.map((task) => task.id);
  const hasActiveFilters = hasActiveTaskFilters(input);
  const emptyState: TaskWorkspaceEmptyState = input.tasks.length === 0 ? 'empty' : visibleTasks.length === 0 && hasActiveFilters ? 'no-results' : undefined;
  const columnPreferences = normalizeTaskTableColumnPreferences(input.taskTableColumns);
  const visibleColumnSet = new Set(columnPreferences.visibleColumnKeys);
  const bulkStatusEligibility = buildBulkStatusEligibility(selectedVisibleTasks);
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
    rows: visibleTasks.map((task) => ({
      id: task.id,
      task,
      selected: task.id === input.selectedTaskId,
      bulkSelected: selectedTaskIdSet.has(task.id),
      action: 'open-detail',
      // macOS 表格行仍保持至少 44px 命中区，保证鼠标与键盘访问都不被压缩。
      minHitArea: 44,
      // 行模型一次性产出所有已知列的稳定文本，后续 UI 可安全按偏好显示且不破坏读屏列名。
      cells: buildTaskTableCells(task, input.runtimeAiAvailable, input.runtimeSessions ?? [], input.projectName),
    })),
    emptyState,
    hasActiveFilters,
    columnPreferences,
    visibleColumns: columnPreferences.columnOrder.filter((columnKey) => visibleColumnSet.has(columnKey)),
    columnOrder: columnPreferences.columnOrder,
  };
}

function buildBulkStatusEligibility(tasks: TaskRecord[]): Record<TaskStatus, TaskBulkStatusEligibility> {
  return taskStatuses.reduce<Record<TaskStatus, TaskBulkStatusEligibility>>(
    (eligibility, targetStatus) => {
      const eligibleTaskIds: string[] = [];
      const skippedTaskIds: string[] = [];
      for (const task of tasks) {
        // 批量状态修改必须先在前端按同一套状态机做预判，避免把明显非法迁移打到本地服务。
        if (canTransitionTaskStatusInWorkspace(task.status, targetStatus)) eligibleTaskIds.push(task.id);
        else skippedTaskIds.push(task.id);
      }
      eligibility[targetStatus] = { targetStatus, eligibleTaskIds, skippedTaskIds };
      return eligibility;
    },
    {} as Record<TaskStatus, TaskBulkStatusEligibility>,
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

export function canTransitionTaskStatusInWorkspace(from: TaskStatus, to: TaskStatus): boolean {
  return allowedTaskStatusTransitions[from]?.includes(to) ?? false;
}

export function formatTaskNextAction(task: TaskRecord, labels?: TaskNextActionLabels): string {
  const customLabel = labels?.[task.status];
  if (customLabel) return customLabel;
  if (task.status === 'draft' || task.status === 'ready') return '可启动 AI';
  if (task.status === 'running') return '等待 AI 输出';
  if (task.status === 'paused') return '可继续';
  if (task.status === 'waiting_confirmation') return '需要我确认';
  if (task.status === 'failed') return '可重试';
  if (task.status === 'completed') return '已完成';
  return '已取消';
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

export function formatRuntimeCommandPreview(session: AiRuntimeSession | undefined, missingLabel: string, sensitiveReplacement = '***'): string {
  if (!session) return missingLabel;
  const args = session.args.map((arg, index, argsList) => maskRuntimeCommandArgument(arg, index, argsList, sensitiveReplacement));
  return [session.command, ...args].join(' ');
}

export function formatRuntimeSessionStatus(session: AiRuntimeSession | undefined, labels?: Partial<Record<AiRuntimeSessionStatus, string>>, missingLabel = '未启动 Runtime 会话'): string {
  if (!session) return missingLabel;
  const defaultLabels: Record<AiRuntimeSessionStatus, string> = {
    running: '运行中',
    exited: '已退出',
    failed: '已失败',
    stopped: '已停止',
    orphan_detected: '孤儿进程',
    lost: '已丢失',
  };
  return labels?.[session.status] ?? defaultLabels[session.status];
}

function buildTaskTableCells(task: TaskRecord, runtimeAiAvailable: boolean | undefined, runtimeSessions: AiRuntimeSession[], projectName?: string): Record<TaskTableColumnKey, TaskTableCellViewModel> {
  const taskRuntimeSession = findLinkedRuntimeSession(task, runtimeSessions);
  const runningSession = taskRuntimeSession?.status === 'running' ? taskRuntimeSession : undefined;
  const displayProjectName = projectName?.trim() || '当前项目';
  return {
    code: { primary: task.taskCode || task.id, secondary: task.taskSequence ? `序号 ${task.taskSequence}` : undefined },
    intent: { primary: task.title, secondary: task.description },
    nextAction: { primary: formatTaskNextAction(task), secondary: `状态：${formatTaskStatusLabel(task.status)}` },
    aiExecution: formatAiExecutionCell(runtimeAiAvailable, runningSession),
    source: { primary: formatTaskSource(task) },
    signals: {
      primary: task.tags?.length ? `标签 ${task.tags.join(' / ')}` : task.priority ? `优先级 ${task.priority}` : '暂无证据',
      secondary: task.tags?.length && task.priority ? `优先级 ${task.priority}` : undefined,
    },
    updatedAt: { primary: formatTaskUpdatedAt(task.updatedAt) },
    createdAt: { primary: formatTaskUpdatedAt(task.createdAt) },
    template: { primary: task.templateId ?? '未绑定模板' },
    project: { primary: displayProjectName },
    priority: { primary: task.priority ?? '未设置' },
    description: { primary: task.description ?? '无描述' },
    runtimeSession: {
      primary: taskRuntimeSession?.id ?? '无运行会话',
      secondary: taskRuntimeSession ? `状态：${taskRuntimeSession.status}` : undefined,
    },
    rawId: { primary: task.id },
    createdFrom: { primary: task.createdFrom ?? 'manual' },
  };
}

function formatAiExecutionCell(runtimeAiAvailable: boolean | undefined, runningSession?: AiRuntimeSession): TaskTableCellViewModel {
  if (runningSession) return { primary: 'AI 运行中', secondary: runningSession.command };
  if (runtimeAiAvailable === false) return { primary: 'AI 未配置' };
  return { primary: '未启动 AI' };
}

function formatTaskSourceType(value: string, labels?: TaskSourceLabels): string | undefined {
  const customLabel = labels?.[value];
  if (customLabel) return customLabel;
  const sourceLabels: Record<string, string> = {
    graph_node: '图谱节点',
    graph_view: '代码图谱',
    runtime_session: 'Runtime 会话',
    template: '任务模板',
    graph_question: '图谱问答',
    manual: '手动创建',
    user: '手动创建',
  };
  // 来源可能来自 createdFrom 或 sourceContextJson.type，统一映射后再进入可访问表格文本，避免 raw enum 被读屏直接读出。
  return sourceLabels[value];
}

function formatTaskStatusLabel(status: TaskStatus): string {
  const labels: Record<TaskStatus, string> = {
    draft: '草稿',
    ready: '就绪',
    running: '运行中',
    paused: '已暂停',
    waiting_confirmation: '待确认',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return labels[status];
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

function maskRuntimeCommandArgument(arg: string, index: number, argsList: string[], sensitiveReplacement: string): string {
  const sensitiveNamePattern = /(?:token|key|password|secret)/iu;
  const inlineMatch = /^(--?[^=\s]*(?:token|key|password|secret)[^=\s]*=)(.*)$/iu.exec(arg);
  if (inlineMatch) return `${inlineMatch[1]}${sensitiveReplacement}`;

  const previous = argsList[index - 1] ?? '';
  if (previous.trim().startsWith('-') && sensitiveNamePattern.test(previous) && !previous.includes('=')) return sensitiveReplacement;
  return arg;
}
