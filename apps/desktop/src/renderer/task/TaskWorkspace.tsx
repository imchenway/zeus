import { lazy, Suspense, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { GearSixIcon as GearSix } from '@phosphor-icons/react/dist/csr/GearSix';
import { isTaskPriority } from '@zeus/shared';
import type { TaskManagementStatusDefinition } from '@zeus/shared';
import type {
  AiRuntimeSession,
  RuntimeStatusSnapshot,
  TaskManagementStatus,
  TaskBoardMoveRequest,
  TaskBoardOpenMode,
  TaskBoardViewSettings,
  TaskBoardViewSnapshot,
  TaskPageViewMode,
  TaskPriority,
  TaskRecord,
  TaskStatusFilter,
  TaskTableColumnKey,
  TaskTableEnumSortOrders,
  TaskTableColumnPreferences,
  UpdateTaskRequest,
} from '../apiClient.js';
import type { NativeConversationChoice } from '../session/sessionTypes.js';
import { Button } from '../ui/Button.js';
import { formatVisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { useNewItemMotionIds } from '../ui/useNewItemMotion.js';
import { ZeusSelect } from '../ZeusSelect.js';
import {
  clampTaskTableColumnWidth,
  createTaskWorkspaceViewModel,
  cycleTaskTableSort,
  defaultTaskTableColumnWidths,
  defaultTaskTableColumnOrder,
  defaultVisibleTaskTableColumns,
  formatTaskManagementStatus,
  getTaskTableColumnWidthBounds,
  moveTaskTableColumnTo,
  normalizeTaskTableColumnPreferences,
  placeTaskTableColumn,
  resolveTaskManagementStatus,
  resolveTaskAgentRunStatus,
  resolveTaskBranchStatus,
  setTaskTableColumnWidth,
  type TaskAgentRunStatus,
  type TaskBranchStatus,
  type TaskTableColumnDropPosition,
  type TaskWorkspaceViewMode,
  taskManagementStatuses,
  toggleTaskTableColumn,
} from './taskWorkspaceModel.js';
import { TaskRunStatusChip, taskBranchStatusTone, taskPriorityTone, taskTypeTone } from './TaskRunStatusChip.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';

const LazyTaskBoardView = lazy(() => import('./TaskBoardView.js').then((module) => ({ default: module.TaskBoardView })));

type TaskPriorityEditResult = { kind: 'updated'; task: TaskRecord } | { kind: 'conflict'; latest: TaskRecord };
type TaskPrioritySaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: string } | { kind: 'conflict'; latest: TaskRecord };

function TaskPriorityControl(props: {
  task: TaskRecord;
  language: 'zh-CN' | 'en-US';
  options: ReadonlyArray<{ value: TaskPriority; label: string }>;
  ariaLabel: string;
  disabled: boolean;
  onSave: (taskId: string, input: UpdateTaskRequest) => Promise<TaskPriorityEditResult>;
}) {
  const statusId = `${useId()}-status`;
  const taskPriority = props.task.priority ?? 'p3';
  const desiredValueRef = useRef<TaskPriority | null>(null);
  const [displayValue, setDisplayValue] = useState(taskPriority);
  const [saveState, setSaveState] = useState<TaskPrioritySaveState>({ kind: 'idle' });
  const zh = props.language === 'zh-CN';
  const legacyLabel = zh ? '历史值' : 'Legacy value';
  const selectOptions: ReadonlyArray<{ value: string; label: string; disabled?: boolean }> = isTaskPriority(taskPriority) ? props.options : [{ value: taskPriority, label: legacyLabel, disabled: true }, ...props.options];

  useEffect(() => {
    if (saveState.kind === 'saving' || saveState.kind === 'error' || saveState.kind === 'conflict') return;
    setDisplayValue(taskPriority);
  }, [saveState.kind, taskPriority]);

  async function savePriority(priority: TaskPriority, expectedUpdatedAt: string): Promise<void> {
    desiredValueRef.current = priority;
    setDisplayValue(priority);
    setSaveState({ kind: 'saving' });
    try {
      const result = await props.onSave(props.task.id, { priority, expectedUpdatedAt });
      if (result.kind === 'conflict') {
        setSaveState({ kind: 'conflict', latest: result.latest });
        return;
      }
      desiredValueRef.current = null;
      setSaveState({ kind: 'idle' });
    } catch (error) {
      setSaveState({ kind: 'error', message: formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en') });
    }
  }

  function retrySave(): void {
    const priority = desiredValueRef.current;
    if (!priority) return;
    const expectedUpdatedAt = saveState.kind === 'conflict' ? (saveState.latest.updatedAt ?? '') : (props.task.updatedAt ?? '');
    if (!expectedUpdatedAt) return;
    void savePriority(priority, expectedUpdatedAt);
  }

  function loadLatestValue(): void {
    const latestPriority = saveState.kind === 'conflict' ? (saveState.latest.priority ?? 'p3') : taskPriority;
    desiredValueRef.current = null;
    setDisplayValue(latestPriority);
    setSaveState({ kind: 'idle' });
  }

  const feedback = saveState.kind === 'conflict' ? (zh ? '保存冲突' : 'Conflict') : saveState.kind === 'error' ? saveState.message : null;
  const triggerLabel = isTaskPriority(displayValue) ? displayValue.toUpperCase() : legacyLabel;

  return (
    <span className={`task-table-priority-control${saveState.kind === 'saving' ? ' is-saving' : ''}`} data-state={saveState.kind} aria-busy={saveState.kind === 'saving' || undefined} onClick={(event) => event.stopPropagation()}>
      <ZeusSelect
        size="compact"
        ariaLabel={props.ariaLabel}
        ariaDescribedBy={feedback ? statusId : undefined}
        value={displayValue}
        options={selectOptions}
        triggerLabel={triggerLabel}
        popoverMinWidth={props.language === 'zh-CN' ? 176 : 210}
        onChange={(value) => {
          if (!isTaskPriority(value)) return;
          if (value === taskPriority) {
            desiredValueRef.current = null;
            setDisplayValue(taskPriority);
            setSaveState({ kind: 'idle' });
            return;
          }
          const expectedUpdatedAt = props.task.updatedAt ?? '';
          if (!expectedUpdatedAt) {
            desiredValueRef.current = value;
            setDisplayValue(value);
            setSaveState({ kind: 'error', message: zh ? '任务缺少更新时间。' : 'Task update time is missing.' });
            return;
          }
          void savePriority(value, expectedUpdatedAt);
        }}
        className={`task-status-select task-priority-select task-status-tone-${taskPriorityTone(displayValue)}`}
        disabled={props.disabled || saveState.kind === 'saving'}
        searchable={false}
      />
      {saveState.kind === 'saving' ? <span className="task-save-spinner" aria-hidden="true" /> : null}
      {feedback ? (
        <span className={`task-table-priority-feedback${saveState.kind === 'error' || saveState.kind === 'conflict' ? ' is-error' : ''}`}>
          <small id={statusId} role="status" aria-live="polite">
            {feedback}
          </small>
          {saveState.kind === 'error' ? (
            <Button variant="secondary" size="compact" onClick={retrySave}>
              {zh ? '重试' : 'Retry'}
            </Button>
          ) : null}
          {saveState.kind === 'conflict' ? (
            <span className="task-table-priority-conflict-actions">
              <Button variant="secondary" size="compact" onClick={retrySave}>
                {zh ? '重试' : 'Retry'}
              </Button>
              <Button variant="secondary" size="compact" onClick={loadLatestValue}>
                {zh ? '载入最新' : 'Load latest'}
              </Button>
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

export interface TaskWorkspaceCopy {
  filterAria: string;
  searchAria: string;
  searchTitle: string;
  statusAria: string;
  statusSelectAria: string;
  statusTitle: string;
  unfinishedStatusFilter: string;
  sortAria: string;
  sortSelectAria: string;
  sortTitle: string;
  selectSearchPlaceholder: string;
  selectNoResults: string;
  rowMetaTitle: string;
  defaultTaskLabel: string;
  templateTaskLabel: string;
  tagsAria: string;
  tagFilterAria: string;
  tagsTitle: string;
  newTask: string;
  today: string;
  emptyTitle: string;
  emptyHelp: string;
  emptySecondaryAction: string;
  emptyOutcomeStatus: string;
  emptyOutcomeAi: string;
  emptyOutcomeEvidence: string;
  noResultsPrimaryAction: string;
  noResultsSecondaryAction: string;
  taskListLoadingToolbarStatus: string;
  taskListLoadingTitle: string;
  taskListLoadingHelp: string;
  taskListLoadingMeta: string;
  taskListErrorToolbarStatus: string;
  taskListErrorTitle: string;
  taskListErrorHelp: string;
  taskListErrorRetry: string;
  taskListErrorProjectSettings: string;
  noResultsTitle: string;
  noResultsHelp: string;
  noProjectSelected: string;
  workbenchAria: string;
  noTags: string;
  aiCliLabel: string;
  aiDetected: string;
  aiNotConfigured: string;
  openTaskDetail: string;
  openRunStatusConversationAria: (taskTitle: string, runStatus: string) => string;
  taskCountPrefix: string;
  filteredState: string;
  allState: string;
  codeColumnTitle: string;
  intentColumnTitle: string;
  taskTypeColumnTitle: string;
  managementStatusColumnTitle: string;
  branchStatusColumnTitle: string;
  runStatusColumnTitle: string;
  sourceColumnTitle: string;
  createdAtColumnTitle: string;
  updatedAtColumnTitle: string;
  priorityColumnTitle: string;
  projectColumnTitle: string;
  templateColumnTitle: string;
  descriptionColumnTitle: string;
  runtimeSessionColumnTitle: string;
  rawIdColumnTitle: string;
  createdFromColumnTitle: string;
  fieldSettings: string;
  fieldSettingsAria: string;
  fieldSettingsHelp: string;
  restoreDefaultColumns: string;
  requiredColumnReason: string;
  moveColumnUpAria: (columnTitle: string) => string;
  moveColumnDownAria: (columnTitle: string) => string;
  compactColumnAria: (columnTitle: string) => string;
  standardColumnAria: (columnTitle: string) => string;
  wideColumnAria: (columnTitle: string) => string;
  selectTaskAria: (taskTitle: string) => string;
  selectAllVisibleTasks: string;
  clearTaskSelection: string;
  bulkSelectedCount: (count: number) => string;
  bulkStatusTargetAria: string;
  bulkStatusTargetTitle: string;
  bulkApplyStatus: string;
  bulkDelete: string;
  bulkDeleteConfirm: (count: number, skippedCount: number) => string;
  bulkStatusSkippedHint: (eligibleCount: number, skippedCount: number) => string;
  taskStatusSelectAria: (taskTitle: string) => string;
  taskPrioritySelectAria: (taskTitle: string) => string;
}

export type TaskWorkspaceBulkActionStatus = { kind: 'idle' | 'running' | 'done' | 'failed'; message?: string };
export type TaskWorkspaceListState = 'ready' | 'loading' | 'error';

export interface TaskWorkspaceProps {
  projectName?: string;
  tasks: TaskRecord[];
  boardTasks?: TaskRecord[];
  selectedTaskId?: string;
  selectedTaskIds?: readonly string[];
  searchQuery: string;
  statusFilter: TaskStatusFilter;
  tagFilter: string;
  statusOptions: readonly TaskStatusFilter[];
  statusLabels: Record<TaskManagementStatus | '', string>;
  statusDefinitions: readonly TaskManagementStatusDefinition[];
  completedStatusId: TaskManagementStatus;
  cancelledStatusId: TaskManagementStatus;
  runStatusLabels: Record<TaskAgentRunStatus, string>;
  priorityOptions: ReadonlyArray<{ value: TaskPriority; label: string }>;
  copy: TaskWorkspaceCopy;
  appLanguage: 'zh-CN' | 'en-US';
  runtime: RuntimeStatusSnapshot;
  runtimeSessions: AiRuntimeSession[];
  taskConversations?: Record<string, NativeConversationChoice[]>;
  conversationRunStatuses?: Record<string, TaskAgentRunStatus>;
  taskTableColumns?: Partial<TaskTableColumnPreferences>;
  taskTableEnumSortOrders?: TaskTableEnumSortOrders;
  taskTableLayoutDirty?: boolean;
  creatingTaskBusy: boolean;
  bulkActionBusy?: boolean;
  statusChangeBusy?: boolean;
  bulkActionStatus?: TaskWorkspaceBulkActionStatus;
  listState?: TaskWorkspaceListState;
  activeProjectId?: string;
  pageViewMode: TaskPageViewMode;
  viewMode: TaskWorkspaceViewMode;
  taskBoardSnapshot?: TaskBoardViewSnapshot | null;
  taskBoardLoading?: boolean;
  taskBoardError?: string | null;
  expandedTaskIds?: readonly string[];
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: TaskStatusFilter) => void;
  onTagFilterChange: (value: string) => void;
  onTaskTableColumnsChange: (value: TaskTableColumnPreferences) => void;
  onSaveTaskTableLayout?: () => void;
  onCreateTask: () => void;
  onOpenTaskDetail: (taskId: string, mode?: TaskBoardOpenMode) => void;
  onOpenTaskConversation?: (taskId: string, conversationId: string) => void;
  onViewModeChange: (viewMode: TaskWorkspaceViewMode) => void;
  onPageViewModeChange: (viewMode: TaskPageViewMode) => void;
  onReloadTaskBoard?: () => void;
  onUpdateTaskBoard?: (settings: Partial<TaskBoardViewSettings>) => Promise<TaskBoardViewSnapshot>;
  onMoveTaskBoardTask?: (input: TaskBoardMoveRequest) => Promise<{ task: TaskRecord; board: TaskBoardViewSnapshot }>;
  onLoadTaskAttachmentPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
  onToggleTaskExpanded: (taskId: string) => void;
  onToggleTaskSelection?: (taskId: string, selected: boolean) => void;
  onToggleAllVisibleTaskSelection?: (taskIds: string[], selected: boolean) => void;
  onClearTaskSelection?: () => void;
  onTaskStatusChange?: (taskId: string, targetStatus: TaskManagementStatus) => void;
  onTaskPriorityChange?: (taskId: string, input: UpdateTaskRequest) => Promise<TaskPriorityEditResult>;
  onBulkTaskStatusChange?: (targetStatus: TaskManagementStatus, taskIds: string[]) => void;
  onBulkTaskDelete?: (taskIds: string[]) => void;
  onRetryTaskList?: () => void;
  onOpenProjectSettings?: () => void;
  onOpenProjectCode?: () => void;
  controlBusyProps: (busy: boolean) => { 'aria-busy'?: true; 'data-loading'?: 'true' };
}

function getTaskTableColumnTrack(columnKey: TaskTableColumnKey, preferences: TaskTableColumnPreferences): string {
  const width = preferences.columnWidths?.[columnKey] ?? defaultTaskTableColumnWidths[columnKey];
  return `${clampTaskTableColumnWidth(columnKey, width)}px`;
}

const taskTableColumnAlignment: Record<TaskTableColumnKey, 'start' | 'end'> = {
  code: 'start',
  intent: 'start',
  taskType: 'start',
  managementStatus: 'start',
  branchStatus: 'start',
  runStatus: 'start',
  source: 'start',
  updatedAt: 'end',
  createdAt: 'end',
  template: 'start',
  project: 'start',
  priority: 'start',
  description: 'start',
  runtimeSession: 'start',
  rawId: 'start',
  createdFrom: 'start',
};

function taskTableCellClassName(columnKey: TaskTableColumnKey, rowCell = false): string {
  const legacyColumnClass: Partial<Record<TaskTableColumnKey, string>> = {
    intent: 'task-table-title-cell',
    managementStatus: 'task-table-task-status-cell',
    updatedAt: 'task-table-updated-cell',
  };
  const legacyRowClass: Partial<Record<TaskTableColumnKey, string>> = {
    intent: 'task-list-copy',
  };
  return ['task-table-cell', legacyColumnClass[columnKey], rowCell ? legacyRowClass[columnKey] : undefined, `task-table-align-${taskTableColumnAlignment[columnKey]}`, `task-table-${columnKey}-cell`].filter(Boolean).join(' ');
}

function focusRelativeTaskRow(currentTarget: HTMLElement, currentElement: HTMLElement, direction: 1 | -1 | 'first' | 'last'): void {
  const rows = Array.from(currentTarget.querySelectorAll<HTMLElement>('[data-task-row-action="open-detail"]'));
  if (rows.length === 0) return;
  const currentIndex = rows.indexOf(currentElement);
  const nextIndex = direction === 'first' ? 0 : direction === 'last' ? rows.length - 1 : Math.min(Math.max(currentIndex + direction, 0), rows.length - 1);
  rows[nextIndex]?.focus();
}

function arrayShallowEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function TaskSelectionCheckbox(props: { ariaLabel: string; checked: boolean; mixed?: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  const checkboxRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!checkboxRef.current) return;
    // 原生 checkbox 的 indeterminate 只能通过 DOM property 设置；ARIA 同步用于读屏表达 mixed。
    checkboxRef.current.indeterminate = Boolean(props.mixed);
  }, [props.mixed]);
  return (
    <input
      ref={checkboxRef}
      type="checkbox"
      aria-label={props.ariaLabel}
      aria-checked={props.mixed ? 'mixed' : props.checked}
      checked={props.checked}
      disabled={props.disabled}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => props.onChange(event.currentTarget.checked)}
    />
  );
}

export function TaskWorkspace(props: TaskWorkspaceProps) {
  const [fieldSettingsOpen, setFieldSettingsOpen] = useState(false);
  const [moreSettingsOpen, setMoreSettingsOpen] = useState(false);
  const [boardSettingsOpen, setBoardSettingsOpen] = useState(false);
  const [draggedColumnKey, setDraggedColumnKey] = useState<TaskTableColumnKey | null>(null);
  const [dragInsertion, setDragInsertion] = useState<{ targetColumnKey: TaskTableColumnKey; position: TaskTableColumnDropPosition } | null>(null);
  const [keyboardMovingColumnKey, setKeyboardMovingColumnKey] = useState<TaskTableColumnKey | null>(null);
  const [columnInteractionAnnouncement, setColumnInteractionAnnouncement] = useState('');
  const [bulkTargetStatus, setBulkTargetStatus] = useState<TaskManagementStatus>(() => props.statusDefinitions[0]?.id ?? 'todo');
  useApplicationErrorDialog(props.listState === 'error' ? props.copy.taskListErrorHelp : null, {
    language: props.appLanguage === 'zh-CN' ? 'zh-CN' : 'en',
  });
  const keyboardMoveStartOrderRef = useRef<TaskTableColumnKey[] | null>(null);
  const resizeStateRef = useRef<{ columnKey: TaskTableColumnKey; startX: number; startWidth: number } | null>(null);
  const fieldSettingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const fieldSettingsPopoverRef = useRef<HTMLElement | null>(null);
  const moreSettingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moreSettingsPopoverRef = useRef<HTMLElement | null>(null);
  const closeFieldSettings = useCallback((restoreFocus = true): void => {
    setFieldSettingsOpen(false);
    if (restoreFocus) fieldSettingsTriggerRef.current?.focus();
  }, []);
  const closeMoreSettings = useCallback((restoreFocus = true): void => {
    setMoreSettingsOpen(false);
    if (restoreFocus) moreSettingsTriggerRef.current?.focus();
  }, []);
  const model = createTaskWorkspaceViewModel({
    tasks: props.tasks,
    query: props.searchQuery,
    status: props.statusFilter,
    tag: props.tagFilter,
    selectedTaskId: props.selectedTaskId,
    selectedTaskIds: props.selectedTaskIds,
    runtimeAiAvailable: props.runtime.aiCli.available,
    runtimeSessions: props.runtimeSessions,
    taskConversations: props.taskConversations,
    conversationRunStatuses: props.conversationRunStatuses,
    managementStatusLabels: props.statusLabels,
    managementStatuses: props.statusDefinitions.map((status) => status.id),
    completedManagementStatusId: props.completedStatusId,
    cancelledManagementStatusId: props.cancelledStatusId,
    runStatusLabels: props.runStatusLabels,
    projectName: props.projectName,
    taskTableColumns: props.taskTableColumns,
    taskTableEnumSortOrders: props.taskTableEnumSortOrders,
    appLanguage: props.appLanguage,
    viewMode: props.viewMode,
    expandedTaskIds: props.expandedTaskIds,
  });
  const columnLabels: Record<TaskTableColumnKey, string> = {
    code: props.copy.codeColumnTitle,
    intent: props.copy.intentColumnTitle,
    taskType: props.copy.taskTypeColumnTitle,
    managementStatus: props.copy.managementStatusColumnTitle,
    branchStatus: props.copy.branchStatusColumnTitle,
    runStatus: props.copy.runStatusColumnTitle,
    source: props.copy.sourceColumnTitle,
    createdAt: props.copy.createdAtColumnTitle,
    updatedAt: props.copy.updatedAtColumnTitle,
    priority: props.copy.priorityColumnTitle,
    project: props.copy.projectColumnTitle,
    template: props.copy.templateColumnTitle,
    description: props.copy.descriptionColumnTitle,
    runtimeSession: props.copy.runtimeSessionColumnTitle,
    rawId: props.copy.rawIdColumnTitle,
    createdFrom: props.copy.createdFromColumnTitle,
  };
  const configuredStatusOptions = props.statusDefinitions.map((status) => status.id);
  const bulkStatusOptions = configuredStatusOptions.length > 0 ? configuredStatusOptions : taskManagementStatuses;
  const statusColorById = new Map(props.statusDefinitions.map((status) => [status.id, status.color]));
  const statusLabel = (status: TaskStatusFilter) =>
    status === 'unfinished' ? props.copy.unfinishedStatusFilter : status === '' ? props.statusLabels[''] || (props.copy.taskCountPrefix === 'Tasks' ? 'All' : '全部') : props.statusLabels[status] || formatTaskManagementStatus(status);
  const bulkTargetEligibility = model.bulkStatusEligibility[bulkTargetStatus] ?? { targetStatus: bulkTargetStatus, eligibleTaskIds: [], skippedTaskIds: [] };
  const selectedVisibleCount = model.selectedVisibleTaskIds.length;
  const bulkActionBusy = Boolean(props.bulkActionBusy);
  const bulkActionStatus = props.bulkActionStatus ?? { kind: 'idle' as const };
  const taskListState = props.listState ?? 'ready';
  const taskListLoading = taskListState === 'loading';
  const taskListError = taskListState === 'error';
  const showEmptyState = !taskListLoading && !taskListError && model.visibleTasks.length === 0;
  const boardRunStatuses = useMemo(
    () => Object.fromEntries(props.tasks.map((task) => [task.id, resolveTaskAgentRunStatus(props.taskConversations?.[task.id] ?? [], props.conversationRunStatuses ?? {})])),
    [props.conversationRunStatuses, props.taskConversations, props.tasks],
  );
  const boardBranchStatuses = useMemo(() => Object.fromEntries(props.tasks.map((task) => [task.id, resolveTaskBranchStatus(props.taskConversations?.[task.id] ?? [])])), [props.taskConversations, props.tasks]);
  const enteringTaskIds = useNewItemMotionIds(props.tasks.map((task) => task.id));
  // visual thesis: 任务表格像 macOS 原生工作台，选择列稳定，批量栏只在选择后低噪音出现，任务列表空态必须保持轻量行。
  // content plan: 顶部仍只服务筛选与新建；选择后追加批量状态、删除与结果提示；单任务详情在右侧悬浮抽屉中展开。
  // interaction thesis: checkbox 只负责选择，行内容负责打开详情，执行反馈通过 aria-live 告知而不打断表格浏览。
  const renderedVisibleColumns = model.visibleColumns;
  const taskTableContentGridTemplate = renderedVisibleColumns.map((columnKey) => getTaskTableColumnTrack(columnKey, model.columnPreferences)).join(' ');
  const taskTableContentWidth = renderedVisibleColumns.reduce((total, columnKey) => total + (model.columnPreferences.columnWidths?.[columnKey] ?? defaultTaskTableColumnWidths[columnKey]), 32);
  // 动态列由模型偏好决定，并和选择列一起写入单一 CSS 变量，header/row 共用同一条轨道。
  const taskTableGridStyle = {
    '--task-table-grid-template': `minmax(32px, 32px) ${taskTableContentGridTemplate}`,
    gridTemplateColumns: 'var(--task-table-grid-template)',
    minWidth: `max(100%, ${Math.round(taskTableContentWidth)}px)`,
  } as CSSProperties & Record<'--task-table-grid-template', string>;
  const hasExpandedTaskTableColumns = taskTableContentWidth > 880;

  useEffect(() => {
    if (bulkStatusOptions.includes(bulkTargetStatus)) return;
    setBulkTargetStatus(bulkStatusOptions[0] ?? 'todo');
  }, [bulkStatusOptions, bulkTargetStatus]);
  const listClassName = [
    'task-list-workbench task-list-protagonist zeus-source-list',
    showEmptyState ? 'task-list-empty' : undefined,
    taskListLoading ? 'task-list-loading' : undefined,
    taskListError ? 'task-list-error' : undefined,
    !showEmptyState && !taskListLoading && !taskListError && model.visibleTasks.length > 0 && hasExpandedTaskTableColumns ? 'task-list-horizontal-scroll' : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  const statusSegmentOptions: TaskStatusFilter[] = [...(props.statusOptions.includes('') ? ([''] as const) : []), ...(props.statusOptions.includes('unfinished') ? (['unfinished'] as const) : []), ...bulkStatusOptions].slice(0, 5);
  const isEnglishCopy = props.copy.taskCountPrefix === 'Tasks';
  const showTaskStatusLine = taskListLoading || taskListError;
  const statusLineTitle = taskListLoading ? props.copy.taskListLoadingTitle : props.copy.taskListErrorTitle;
  const statusLineHelp = taskListLoading ? props.copy.taskListLoadingHelp : props.copy.taskListErrorHelp;
  const visibleTaskCountLabel = taskListLoading ? props.copy.taskListLoadingMeta : props.copy.taskListErrorRetry;
  const batchViewActionLabel = isEnglishCopy ? 'Batch' : '批量';
  const columnViewActionLabel = isEnglishCopy ? 'Columns' : '列';
  const moreViewActionLabel = isEnglishCopy ? 'More' : '更多';
  const saveViewActionLabel = isEnglishCopy ? 'Save' : '保存';
  const resetColumnsActionLabel = isEnglishCopy ? 'Reset columns' : '恢复默认列';
  const handleResetTaskFilters = () => {
    props.onSearchChange('');
    props.onTagFilterChange('');
    props.onStatusFilterChange('');
  };
  const handleViewAllTaskStates = () => {
    props.onStatusFilterChange('');
  };
  const filtersHaveValue = Boolean(props.searchQuery.trim() || props.tagFilter.trim() || props.statusFilter);
  const columnsHaveCustomPreferences =
    !arrayShallowEqual(model.columnPreferences.visibleColumnKeys, defaultVisibleTaskTableColumns) ||
    !arrayShallowEqual(model.columnPreferences.columnOrder, defaultTaskTableColumnOrder) ||
    Object.entries(model.columnPreferences.columnWidths ?? {}).some(([columnKey, width]) => width !== defaultTaskTableColumnWidths[columnKey as TaskTableColumnKey]) ||
    Boolean(model.columnPreferences.sort.columnKey);
  const moreActionsAvailable = filtersHaveValue || columnsHaveCustomPreferences;
  const handleMoreResetTaskFilters = () => {
    if (!filtersHaveValue) return;
    handleResetTaskFilters();
    closeMoreSettings();
  };
  const handleMoreRestoreDefaultColumns = () => {
    if (!columnsHaveCustomPreferences) return;
    props.onTaskTableColumnsChange(normalizeTaskTableColumnPreferences());
    closeMoreSettings();
  };
  // 任务页首屏不默认选中第一行，避免固定灰底；但仍保留第一行作为键盘进入表格后的 roving focus 起点。
  const keyboardEntryTaskId = model.rows.find((row) => row.selected)?.task.id ?? model.rows[0]?.task.id;

  useEffect(() => {
    if (bulkStatusOptions.length === 0 || bulkStatusOptions.includes(bulkTargetStatus)) return;
    setBulkTargetStatus(bulkStatusOptions[0]);
  }, [bulkStatusOptions, bulkTargetStatus]);

  useEffect(() => {
    if (!fieldSettingsOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeFieldSettings(true);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (fieldSettingsTriggerRef.current?.contains(target) || fieldSettingsPopoverRef.current?.contains(target)) return;
      closeFieldSettings(true);
    };

    // 字段浮层遵循 Zeus popover 契约：Escape / 外部点击关闭，并把焦点还给触发器。
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [closeFieldSettings, fieldSettingsOpen]);

  useEffect(() => {
    if (moreSettingsOpen && !moreActionsAvailable) {
      closeMoreSettings(false);
      return;
    }
    if (!moreSettingsOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMoreSettings(true);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (moreSettingsTriggerRef.current?.contains(target) || moreSettingsPopoverRef.current?.contains(target)) return;
      closeMoreSettings(true);
    };

    // 更多任务动作使用显式 popover，不恢复浏览器默认三角 chrome。
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [closeMoreSettings, moreActionsAvailable, moreSettingsOpen]);

  const handleListKeyboardNavigation = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (!event.target.matches('[data-task-row-action="open-detail"]')) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRelativeTaskRow(event.currentTarget, event.target, 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRelativeTaskRow(event.currentTarget, event.target, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusRelativeTaskRow(event.currentTarget, event.target, 'first');
    } else if (event.key === 'End') {
      event.preventDefault();
      focusRelativeTaskRow(event.currentTarget, event.target, 'last');
    }
  };

  const announceColumnPosition = (columnKey: TaskTableColumnKey, preferences: TaskTableColumnPreferences) => {
    const visibleColumns = preferences.columnOrder.filter((key) => preferences.visibleColumnKeys.includes(key));
    const position = visibleColumns.indexOf(columnKey) + 1;
    const title = columnLabels[columnKey];
    setColumnInteractionAnnouncement(isEnglishCopy ? `${title} is column ${position} of ${visibleColumns.length}.` : `${title} 已移至第 ${position} 列，共 ${visibleColumns.length} 列。`);
  };

  const clearColumnDragState = () => {
    setDraggedColumnKey(null);
    setDragInsertion(null);
  };

  const handleColumnDragStart = (event: ReactDragEvent<HTMLElement>, columnKey: TaskTableColumnKey) => {
    setDraggedColumnKey(columnKey);
    setDragInsertion(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', columnKey);
  };

  const handleColumnDragOver = (event: ReactDragEvent<HTMLElement>, targetColumnKey: TaskTableColumnKey) => {
    if (!draggedColumnKey) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (draggedColumnKey === targetColumnKey) {
      setDragInsertion(null);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const position: TaskTableColumnDropPosition = event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
    setDragInsertion((current) => (current?.targetColumnKey === targetColumnKey && current.position === position ? current : { targetColumnKey, position }));
  };

  const handleColumnDrop = (event: ReactDragEvent<HTMLElement>, targetColumnKey: TaskTableColumnKey) => {
    event.preventDefault();
    if (!draggedColumnKey || draggedColumnKey === targetColumnKey) {
      clearColumnDragState();
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const position: TaskTableColumnDropPosition = event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
    const nextPreferences = placeTaskTableColumn(model.columnPreferences, draggedColumnKey, targetColumnKey, position);
    props.onTaskTableColumnsChange(nextPreferences);
    announceColumnPosition(draggedColumnKey, nextPreferences);
    clearColumnDragState();
  };

  const handleColumnMoveKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, columnKey: TaskTableColumnKey) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (keyboardMovingColumnKey === columnKey) {
        setKeyboardMovingColumnKey(null);
        keyboardMoveStartOrderRef.current = null;
        setColumnInteractionAnnouncement(isEnglishCopy ? `${columnLabels[columnKey]} position saved in the draft.` : `${columnLabels[columnKey]} 的位置已写入草稿。`);
      } else {
        keyboardMoveStartOrderRef.current = [...model.columnPreferences.columnOrder];
        setKeyboardMovingColumnKey(columnKey);
        setColumnInteractionAnnouncement(isEnglishCopy ? `Moving ${columnLabels[columnKey]}. Use Left and Right arrows, then press Space to finish.` : `正在移动${columnLabels[columnKey]}。使用左右方向键调整，按空格完成。`);
      }
      return;
    }
    if (event.key === 'Escape' && keyboardMovingColumnKey === columnKey) {
      event.preventDefault();
      const startOrder = keyboardMoveStartOrderRef.current;
      if (startOrder) props.onTaskTableColumnsChange(normalizeTaskTableColumnPreferences({ ...model.columnPreferences, columnOrder: startOrder }));
      setKeyboardMovingColumnKey(null);
      keyboardMoveStartOrderRef.current = null;
      setColumnInteractionAnnouncement(isEnglishCopy ? 'Column move cancelled.' : '已取消移动列。');
      return;
    }
    if (keyboardMovingColumnKey !== columnKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const visibleColumns = model.visibleColumns;
    const currentIndex = visibleColumns.indexOf(columnKey);
    const targetIndex = event.key === 'ArrowLeft' ? currentIndex - 1 : currentIndex + 1;
    const targetColumnKey = visibleColumns[targetIndex];
    if (!targetColumnKey) return;
    const nextPreferences = moveTaskTableColumnTo(model.columnPreferences, columnKey, targetColumnKey);
    props.onTaskTableColumnsChange(nextPreferences);
    announceColumnPosition(columnKey, nextPreferences);
  };

  const handleColumnResizePointerDown = (event: ReactPointerEvent<HTMLElement>, columnKey: TaskTableColumnKey) => {
    event.preventDefault();
    event.stopPropagation();
    const startWidth = model.columnPreferences.columnWidths?.[columnKey] ?? defaultTaskTableColumnWidths[columnKey];
    resizeStateRef.current = { columnKey, startX: event.clientX, startWidth };
    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) return;
      const width = clampTaskTableColumnWidth(resizeState.columnKey, resizeState.startWidth + pointerEvent.clientX - resizeState.startX);
      props.onTaskTableColumnsChange(setTaskTableColumnWidth(model.columnPreferences, resizeState.columnKey, width));
    };
    const handlePointerUp = () => {
      resizeStateRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
  };

  const handleColumnResizeKeyDown = (event: ReactKeyboardEvent<HTMLElement>, columnKey: TaskTableColumnKey) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
    event.preventDefault();
    const currentWidth = model.columnPreferences.columnWidths?.[columnKey] ?? defaultTaskTableColumnWidths[columnKey];
    const delta = event.shiftKey ? 24 : 8;
    const nextWidth = event.key === 'Home' ? defaultTaskTableColumnWidths[columnKey] : currentWidth + (event.key === 'ArrowLeft' ? -delta : delta);
    props.onTaskTableColumnsChange(setTaskTableColumnWidth(model.columnPreferences, columnKey, nextWidth));
  };

  return (
    <section className="task-management-codex-layout task-table-only-layout task-table-layout" aria-label={props.copy.workbenchAria}>
      <section className="task-management-navigation task-table-workbench" role={props.pageViewMode === 'list' ? 'grid' : undefined} aria-label={props.copy.filterAria}>
        <section className="task-filter-workbench task-filter-toolbar task-table-toolbar task-table-primary-toolbar" aria-label={props.copy.filterAria}>
          <label className="task-filter-control-row task-filter-search task-toolbar-search" aria-label={props.copy.searchAria}>
            <span className="sr-only">{props.copy.searchTitle}</span>
            <input type="search" aria-label={props.copy.searchAria} placeholder={props.copy.searchTitle} value={props.searchQuery} onChange={(event) => props.onSearchChange(event.currentTarget.value)} />
          </label>
          <div className="task-filter-control-row task-filter-field task-table-status-segments" role="group" aria-label={props.copy.statusAria}>
            <span className="sr-only">{props.copy.statusTitle}</span>
            {statusSegmentOptions.map((status) => (
              <button className="task-table-status-segment" type="button" aria-pressed={props.statusFilter === status} key={status || 'all'} onClick={() => props.onStatusFilterChange(status)}>
                {status !== '' && status !== 'unfinished' ? <span className="task-status-filter-dot" style={{ backgroundColor: statusColorById.get(status) ?? '#6b7280' }} aria-hidden="true" /> : null}
                {statusLabel(status)}
              </button>
            ))}
          </div>
          <div className="task-table-view-actions" aria-label={isEnglishCopy ? 'Task view actions' : '任务视图动作'}>
            <div className="task-table-page-view-segments" role="group" aria-label={isEnglishCopy ? 'Task view' : '任务视图'}>
              <button className="task-table-view-pill" type="button" aria-pressed={props.pageViewMode === 'list'} onClick={() => props.onPageViewModeChange('list')}>
                {isEnglishCopy ? 'List' : '列表'}
              </button>
              <button className="task-table-view-pill" type="button" aria-pressed={props.pageViewMode === 'board'} onClick={() => props.onPageViewModeChange('board')}>
                {isEnglishCopy ? 'Board' : '看板'}
              </button>
            </div>
            {props.pageViewMode === 'board' ? (
              <button
                className="task-table-view-pill task-table-board-settings-trigger"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={boardSettingsOpen}
                aria-label={isEnglishCopy ? 'Board settings' : '看板设置'}
                title={isEnglishCopy ? 'Board settings' : '看板设置'}
                onClick={() => setBoardSettingsOpen(true)}
              >
                <GearSix aria-hidden="true" />
                <span>{isEnglishCopy ? 'Settings' : '设置'}</span>
              </button>
            ) : null}
            {props.pageViewMode === 'list' ? (
              <>
                <div className="task-table-view-mode-segments" role="group" aria-label={isEnglishCopy ? 'List layout' : '列表排列方式'}>
                  <button className="task-table-view-pill" type="button" aria-pressed={props.viewMode === 'hierarchy'} onClick={() => props.onViewModeChange('hierarchy')}>
                    {isEnglishCopy ? 'Hierarchy' : '层级'}
                  </button>
                  <button className="task-table-view-pill" type="button" aria-pressed={props.viewMode === 'flat'} onClick={() => props.onViewModeChange('flat')}>
                    {isEnglishCopy ? 'Flat' : '平铺'}
                  </button>
                </div>
                <button
                  className="task-table-view-pill task-table-view-bulk-pill"
                  type="button"
                  disabled={bulkActionBusy || model.visibleTaskIds.length === 0}
                  onClick={() => props.onToggleAllVisibleTaskSelection?.(model.visibleTaskIds, !model.allVisibleSelected)}
                >
                  {batchViewActionLabel}
                </button>
                <div className="task-table-field-settings">
                  {/* 字段配置属于低频视图偏好，在主工具条中只保留紧凑入口，并以 overlay 展开。 */}
                  <button
                    ref={fieldSettingsTriggerRef}
                    className="task-table-view-pill task-table-view-pill-strong task-table-field-settings-trigger"
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded={fieldSettingsOpen}
                    aria-controls="task-table-field-settings-popover"
                    aria-label={props.copy.fieldSettingsAria}
                    title={props.copy.fieldSettingsAria}
                    onClick={() => setFieldSettingsOpen((open) => !open)}
                  >
                    <span className="task-table-field-settings-label">{columnViewActionLabel}</span>
                  </button>
                  <section
                    ref={fieldSettingsPopoverRef}
                    id="task-table-field-settings-popover"
                    className="task-table-field-settings-popover"
                    role="dialog"
                    aria-label={props.copy.fieldSettingsAria}
                    hidden={!fieldSettingsOpen}
                    data-open={fieldSettingsOpen ? 'true' : 'false'}
                  >
                    {/* 字段弹层是有边界的 popover：标题说明固定、字段列表独立滚动、底部恢复动作固定，避免在小分辨率下被裁切。 */}
                    <header className="task-table-field-settings-heading">
                      <strong>{props.copy.fieldSettingsAria}</strong>
                      <small>{props.copy.fieldSettingsHelp}</small>
                    </header>
                    <div className="task-table-field-settings-list">
                      {model.columnPreferences.columnOrder.map((columnKey) => {
                        const columnTitle = columnLabels[columnKey];
                        const isRequiredColumn = columnKey === 'code' || columnKey === 'intent';
                        const requiredReasonId = `task-table-field-${columnKey}-reason`;
                        return (
                          <div className="task-table-field-option" key={columnKey}>
                            <label className="task-table-field-option-label">
                              <input
                                type="checkbox"
                                checked={model.columnPreferences.visibleColumnKeys.includes(columnKey)}
                                disabled={isRequiredColumn}
                                aria-describedby={isRequiredColumn ? requiredReasonId : undefined}
                                onChange={(event) => props.onTaskTableColumnsChange(toggleTaskTableColumn(model.columnPreferences, columnKey, event.currentTarget.checked))}
                              />
                              <span className="task-table-field-option-copy">
                                <span>{columnTitle}</span>
                                {isRequiredColumn ? (
                                  <small id={requiredReasonId} className="task-table-required-reason">
                                    {props.copy.requiredColumnReason}
                                  </small>
                                ) : null}
                              </span>
                            </label>
                          </div>
                        );
                      })}
                    </div>
                    <footer className="task-table-field-settings-footer">
                      <button type="button" className="task-table-field-reset" onClick={() => props.onTaskTableColumnsChange(normalizeTaskTableColumnPreferences())}>
                        {props.copy.restoreDefaultColumns}
                      </button>
                    </footer>
                  </section>
                </div>
                {props.taskTableLayoutDirty ? (
                  <button className="task-table-view-pill task-table-view-save-pill" type="button" onClick={props.onSaveTaskTableLayout} disabled={!props.onSaveTaskTableLayout}>
                    {saveViewActionLabel}
                  </button>
                ) : (
                  <div className="task-table-more-settings">
                    <button
                      ref={moreSettingsTriggerRef}
                      className="task-table-view-pill task-table-more-settings-trigger"
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={moreSettingsOpen}
                      aria-controls="task-table-more-settings-popover"
                      disabled={!moreActionsAvailable}
                      aria-disabled={!moreActionsAvailable}
                      onClick={() => {
                        if (!moreActionsAvailable) return;
                        setMoreSettingsOpen((open) => !open);
                      }}
                    >
                      {moreViewActionLabel}
                    </button>
                    {moreActionsAvailable ? (
                      <section
                        ref={moreSettingsPopoverRef}
                        id="task-table-more-settings-popover"
                        className="task-table-view-more-panel"
                        role="menu"
                        aria-label={isEnglishCopy ? 'More task view actions' : '更多任务视图动作'}
                        hidden={!moreSettingsOpen}
                        data-open={moreSettingsOpen ? 'true' : 'false'}
                      >
                        {filtersHaveValue ? (
                          <button className="task-table-more-menu-action" type="button" role="menuitem" onClick={handleMoreResetTaskFilters}>
                            <span>{props.copy.noResultsPrimaryAction}</span>
                            <small>{isEnglishCopy ? 'Reset search, status and tag filters.' : '重置搜索、状态和标签筛选'}</small>
                          </button>
                        ) : null}
                        {columnsHaveCustomPreferences ? (
                          <button className="task-table-more-menu-action" type="button" role="menuitem" onClick={handleMoreRestoreDefaultColumns}>
                            <span>{resetColumnsActionLabel}</span>
                            <small>{isEnglishCopy ? 'Return task columns to the default view.' : '恢复默认任务列视图'}</small>
                          </button>
                        ) : null}
                      </section>
                    ) : null}
                  </div>
                )}
              </>
            ) : null}
          </div>
          <button className="task-table-new-task-button" type="button" onClick={props.onCreateTask} disabled={!props.activeProjectId || props.creatingTaskBusy} {...props.controlBusyProps(props.creatingTaskBusy)}>
            {props.copy.newTask}
          </button>
        </section>
        {props.pageViewMode === 'board' ? (
          <Suspense
            fallback={
              <section className="task-board-state" role="status" aria-live="polite">
                <strong>{isEnglishCopy ? 'Loading board…' : '正在加载看板…'}</strong>
              </section>
            }
          >
            <LazyTaskBoardView
              projectId={props.activeProjectId ?? ''}
              language={props.appLanguage}
              tasks={props.boardTasks ?? model.visibleTasks}
              snapshot={props.taskBoardSnapshot ?? null}
              loading={Boolean(props.taskBoardLoading)}
              error={props.taskBoardError ?? null}
              statusDefinitions={props.statusDefinitions}
              runStatuses={boardRunStatuses}
              branchStatuses={boardBranchStatuses}
              settingsOpen={boardSettingsOpen}
              onSettingsOpenChange={setBoardSettingsOpen}
              onReload={() => props.onReloadTaskBoard?.()}
              onUpdateSettings={(settings) => {
                if (!props.onUpdateTaskBoard) return Promise.reject(new Error(isEnglishCopy ? 'Board settings are unavailable.' : '看板设置能力不可用。'));
                return props.onUpdateTaskBoard(settings);
              }}
              onMoveTask={(input) => {
                if (!props.onMoveTaskBoardTask) return Promise.reject(new Error(isEnglishCopy ? 'Board move is unavailable.' : '看板移动能力不可用。'));
                return props.onMoveTaskBoardTask(input);
              }}
              onOpenTask={props.onOpenTaskDetail}
              onLoadAttachmentPreview={props.onLoadTaskAttachmentPreview}
            />
          </Suspense>
        ) : (
          <>
            {selectedVisibleCount > 0 ? (
              <section className="task-table-bulk-action-bar" aria-label={props.copy.bulkStatusTargetTitle}>
                <strong className="task-table-bulk-count">{props.copy.bulkSelectedCount(selectedVisibleCount)}</strong>
                <button
                  type="button"
                  className="task-table-bulk-secondary-button"
                  disabled={bulkActionBusy || model.visibleTaskIds.length === 0}
                  onClick={() => props.onToggleAllVisibleTaskSelection?.(model.visibleTaskIds, !model.allVisibleSelected)}
                >
                  {props.copy.selectAllVisibleTasks}
                </button>
                <button type="button" className="task-table-bulk-secondary-button" disabled={bulkActionBusy} onClick={() => props.onClearTaskSelection?.()}>
                  {props.copy.clearTaskSelection}
                </button>
                <label className="task-table-bulk-status-control" aria-label={props.copy.bulkStatusTargetTitle}>
                  <span className="sr-only">{props.copy.bulkStatusTargetTitle}</span>
                  <ZeusSelect
                    size="compact"
                    ariaLabel={props.copy.bulkStatusTargetAria}
                    value={bulkTargetStatus}
                    onChange={setBulkTargetStatus}
                    searchPlaceholder={props.copy.selectSearchPlaceholder}
                    emptyLabel={props.copy.selectNoResults}
                    searchable={false}
                    options={bulkStatusOptions.map((status) => ({
                      value: status,
                      label: statusLabel(status),
                      color: statusColorById.get(status),
                    }))}
                  />
                </label>
                <span className="task-table-bulk-hint">{props.copy.bulkStatusSkippedHint(bulkTargetEligibility.eligibleTaskIds.length, bulkTargetEligibility.skippedTaskIds.length)}</span>
                <button
                  type="button"
                  className="task-table-bulk-apply-button"
                  disabled={bulkActionBusy || bulkTargetEligibility.eligibleTaskIds.length === 0}
                  onClick={() => props.onBulkTaskStatusChange?.(bulkTargetStatus, model.selectedVisibleTaskIds)}
                  {...props.controlBusyProps(bulkActionBusy)}
                >
                  {props.copy.bulkApplyStatus}
                </button>
                <button
                  type="button"
                  className="task-table-bulk-delete-button"
                  disabled={bulkActionBusy || model.bulkDeleteEligibility.eligibleTaskIds.length === 0}
                  onClick={() => props.onBulkTaskDelete?.(model.selectedVisibleTaskIds)}
                  {...props.controlBusyProps(bulkActionBusy)}
                >
                  {props.copy.bulkDelete}
                </button>
                {bulkActionStatus.message ? (
                  <span className={`task-table-bulk-status task-table-bulk-status-${bulkActionStatus.kind}`} role="status" aria-live="polite">
                    {bulkActionStatus.message}
                  </span>
                ) : null}
              </section>
            ) : null}
            {showTaskStatusLine ? (
              <div className="task-table-status-line">
                <span>
                  <strong>{statusLineTitle}</strong>
                  <span> · {statusLineHelp}</span>
                </span>
                <span>{visibleTaskCountLabel}</span>
              </div>
            ) : null}
            <section className={listClassName} role="rowgroup" data-source-list-keyboard="vertical" aria-label={props.copy.today} aria-busy={taskListLoading ? true : undefined} onKeyDown={handleListKeyboardNavigation}>
              {renderedVisibleColumns.length > 0 ? (
                <div className="task-table-header" role="row" style={taskTableGridStyle}>
                  <span className="task-table-cell task-table-select-cell" role="columnheader">
                    <TaskSelectionCheckbox
                      ariaLabel={props.copy.selectAllVisibleTasks}
                      checked={model.allVisibleSelected}
                      mixed={model.someVisibleSelected && !model.allVisibleSelected}
                      disabled={bulkActionBusy || model.visibleTaskIds.length === 0}
                      onChange={(selected) => props.onToggleAllVisibleTaskSelection?.(model.visibleTaskIds, selected)}
                    />
                  </span>
                  {renderedVisibleColumns.map((columnKey) => {
                    const sortDirection = model.columnPreferences.sort.columnKey === columnKey ? model.columnPreferences.sort.direction : null;
                    const width = model.columnPreferences.columnWidths?.[columnKey] ?? defaultTaskTableColumnWidths[columnKey];
                    const bounds = getTaskTableColumnWidthBounds(columnKey);
                    const sortLabel = sortDirection === 'asc' ? (isEnglishCopy ? 'ascending' : '升序') : sortDirection === 'desc' ? (isEnglishCopy ? 'descending' : '降序') : isEnglishCopy ? 'not sorted' : '未排序';
                    return (
                      <span
                        className={[
                          taskTableCellClassName(columnKey),
                          'task-table-interactive-header',
                          draggedColumnKey === columnKey ? 'dragging' : undefined,
                          dragInsertion?.targetColumnKey === columnKey ? `drop-${dragInsertion.position}` : undefined,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        role="columnheader"
                        aria-sort={sortDirection === 'asc' ? 'ascending' : sortDirection === 'desc' ? 'descending' : 'none'}
                        key={columnKey}
                        onDragOver={(event) => handleColumnDragOver(event, columnKey)}
                        onDrop={(event) => handleColumnDrop(event, columnKey)}
                      >
                        <button
                          type="button"
                          className="task-table-column-drag-handle"
                          draggable
                          aria-pressed={keyboardMovingColumnKey === columnKey}
                          aria-label={isEnglishCopy ? `Move ${columnLabels[columnKey]} column` : `移动${columnLabels[columnKey]}列`}
                          title={isEnglishCopy ? 'Drag to reorder. Keyboard: Space, arrows, Space.' : '拖动调整位置；键盘可按空格、方向键、空格。'}
                          onDragStart={(event) => handleColumnDragStart(event, columnKey)}
                          onDragEnd={clearColumnDragState}
                          onKeyDown={(event) => handleColumnMoveKeyDown(event, columnKey)}
                        >
                          <span aria-hidden="true">⋮⋮</span>
                        </button>
                        <button
                          type="button"
                          className="task-table-column-sort-button"
                          draggable
                          aria-label={isEnglishCopy ? `Sort by ${columnLabels[columnKey]}; currently ${sortLabel}` : `按${columnLabels[columnKey]}排序；当前${sortLabel}`}
                          title={isEnglishCopy ? `Click to sort (${sortLabel}); drag to reorder.` : `点击排序（${sortLabel}）；拖动调整列位置。`}
                          onDragStart={(event) => handleColumnDragStart(event, columnKey)}
                          onDragEnd={clearColumnDragState}
                          onClick={() => props.onTaskTableColumnsChange(cycleTaskTableSort(model.columnPreferences, columnKey))}
                        >
                          <span>{columnLabels[columnKey]}</span>
                          {sortDirection ? (
                            <span className="task-table-column-sort-indicator" aria-hidden="true">
                              {sortDirection === 'asc' ? '↑' : '↓'}
                            </span>
                          ) : null}
                        </button>
                        <span
                          className="task-table-column-resize-handle"
                          role="separator"
                          tabIndex={0}
                          aria-orientation="vertical"
                          aria-valuemin={bounds.min}
                          aria-valuemax={bounds.max}
                          aria-valuenow={width}
                          aria-label={isEnglishCopy ? `Resize ${columnLabels[columnKey]} column` : `调整${columnLabels[columnKey]}列宽`}
                          onPointerDown={(event) => handleColumnResizePointerDown(event, columnKey)}
                          onKeyDown={(event) => handleColumnResizeKeyDown(event, columnKey)}
                        />
                      </span>
                    );
                  })}
                </div>
              ) : null}
              <span className="sr-only" role="status" aria-live="polite">
                {columnInteractionAnnouncement}
              </span>
              {taskListLoading ? (
                // 加载态只替换表格内容，不替换工具条和列头，用户能确认即将出现的数据结构。
                <section className="task-list-state-row task-list-loading-state" role="status" aria-live="polite">
                  <span className="task-list-state-copy">
                    <strong>{props.copy.taskListLoadingTitle}</strong>
                    <small>{props.copy.taskListLoadingHelp}</small>
                  </span>
                  <span className="task-loading-skeleton-stack" aria-hidden="true">
                    <span className="task-loading-skeleton-line" />
                    <span className="task-loading-skeleton-line" />
                    <span className="task-loading-skeleton-line short" />
                  </span>
                </section>
              ) : taskListError ? (
                // 弹窗负责错误事实；列表区只保留可恢复操作，避免关闭弹窗后失去重试入口。
                <section className="project-inline-recovery-row task-list-state-row" aria-label={props.copy.taskListErrorTitle} role="status">
                  <span className="task-list-state-mark" aria-hidden="true">
                    !
                  </span>
                  <span className="project-inline-recovery-copy task-list-state-copy">
                    <strong>{props.copy.taskListErrorRetry}</strong>
                  </span>
                  <span className="task-list-state-action-rail">
                    <button type="button" className="task-list-state-primary-action" onClick={props.onRetryTaskList} disabled={!props.onRetryTaskList}>
                      {props.copy.taskListErrorRetry}
                    </button>
                    <button type="button" className="task-list-state-secondary-action" onClick={props.onOpenProjectSettings} disabled={!props.onOpenProjectSettings}>
                      {props.copy.taskListErrorProjectSettings}
                    </button>
                  </span>
                </section>
              ) : model.visibleTasks.length === 0 ? (
                // visual thesis: 空任务态只说明任务页价值与下一步，不重复顶部主操作；筛选无结果才显示恢复动作。
                // 空态必须以当前可见列表区为居中基准，不能被横向溢出的表头宽度拉偏。
                <section
                  className={['project-inline-recovery-row task-list-empty-row task-empty-state', model.emptyState === 'no-results' ? 'task-empty-state-with-actions' : 'task-empty-state-copy-only'].join(' ')}
                  aria-label={model.emptyState === 'no-results' ? props.copy.noResultsTitle : props.copy.emptyTitle}
                  role="region"
                >
                  <span className="task-empty-state-mark" aria-hidden="true">
                    0
                  </span>
                  <span className="project-inline-recovery-copy task-empty-state-copy">
                    <strong>{model.emptyState === 'no-results' ? props.copy.noResultsTitle : props.copy.emptyTitle}</strong>
                    <small>{model.emptyState === 'no-results' ? props.copy.noResultsHelp : props.copy.emptyHelp}</small>
                  </span>
                  {model.emptyState === 'no-results' ? (
                    <span className="task-empty-state-action-rail">
                      <button className="task-empty-state-primary-action" type="button" onClick={handleResetTaskFilters}>
                        {props.copy.noResultsPrimaryAction}
                      </button>
                      <button className="task-empty-state-secondary-action" type="button" onClick={handleViewAllTaskStates}>
                        {props.copy.noResultsSecondaryAction}
                      </button>
                    </span>
                  ) : null}
                </section>
              ) : (
                model.rows.map((row) => {
                  const task = row.task;
                  const managementStatus = resolveTaskManagementStatus(task);
                  const branchStatus = row.cells.branchStatus.sortValue as TaskBranchStatus;
                  const runStatus = row.cells.runStatus.sortValue as TaskAgentRunStatus;
                  const runStatusConversationId = row.runStatusConversationId;
                  return (
                    <div
                      key={task.id}
                      className={row.selected ? 'task-list-row selected task-table-row' : 'task-list-row task-table-row'}
                      role="row"
                      style={taskTableGridStyle}
                      aria-selected={row.selected}
                      aria-label={`${props.copy.openTaskDetail}：${task.title}`}
                      tabIndex={task.id === keyboardEntryTaskId ? 0 : -1}
                      data-source-list-item="true"
                      data-task-row-action={row.action}
                      data-motion-surface="list-item"
                      data-motion-state={enteringTaskIds.has(task.id) ? 'entering' : undefined}
                      onClick={(event) => {
                        event.currentTarget.focus();
                        props.onOpenTaskDetail(task.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        props.onOpenTaskDetail(task.id);
                      }}
                    >
                      {/* 任务列表是任务页布局主角：点击任务行打开右侧悬浮详情抽屉，列表本身不提前塞入 Runtime、完成、取消等推进按钮。 */}
                      <span className="task-table-cell task-table-select-cell" role="gridcell" onClick={(event) => event.stopPropagation()}>
                        <TaskSelectionCheckbox ariaLabel={props.copy.selectTaskAria(task.title)} checked={row.bulkSelected} disabled={bulkActionBusy} onChange={(selected) => props.onToggleTaskSelection?.(task.id, selected)} />
                      </span>
                      {renderedVisibleColumns.map((columnKey) => {
                        const cell = row.cells[columnKey];
                        return (
                          <span className={taskTableCellClassName(columnKey, true)} role="gridcell" key={columnKey} data-column-label={columnLabels[columnKey]}>
                            {columnKey === 'taskType' ? (
                              <span className={`task-status-chip task-type-chip task-status-tone-${taskTypeTone(task.taskType)}`}>
                                <strong>{cell.primary}</strong>
                              </span>
                            ) : columnKey === 'managementStatus' ? (
                              <span className="task-table-row-status-control" onClick={(event) => event.stopPropagation()}>
                                <ZeusSelect
                                  size="compact"
                                  ariaLabel={props.copy.taskStatusSelectAria(task.title)}
                                  value={managementStatus}
                                  options={bulkStatusOptions.map((status) => ({
                                    value: status,
                                    label: statusLabel(status),
                                    color: statusColorById.get(status),
                                  }))}
                                  onChange={(status) => props.onTaskStatusChange?.(task.id, status)}
                                  className="task-status-select task-status-custom"
                                  style={{ '--task-status-tone': statusColorById.get(managementStatus) ?? '#6b7280' } as CSSProperties}
                                  disabled={props.statusChangeBusy || !props.onTaskStatusChange}
                                  searchable={false}
                                />
                              </span>
                            ) : columnKey === 'branchStatus' ? (
                              <span className={`task-status-chip task-branch-status-chip task-status-tone-${taskBranchStatusTone(branchStatus)}`}>
                                <strong>{cell.primary}</strong>
                              </span>
                            ) : columnKey === 'runStatus' ? (
                              <TaskRunStatusChip
                                status={runStatus}
                                label={cell.primary}
                                ariaLabel={runStatusConversationId && props.onOpenTaskConversation ? props.copy.openRunStatusConversationAria(task.title, cell.primary) : cell.primary}
                                onClick={
                                  runStatusConversationId && props.onOpenTaskConversation
                                    ? (event) => {
                                        event.stopPropagation();
                                        props.onOpenTaskConversation?.(task.id, runStatusConversationId);
                                      }
                                    : undefined
                                }
                              />
                            ) : columnKey === 'priority' ? (
                              <TaskPriorityControl
                                task={task}
                                language={props.appLanguage}
                                options={props.priorityOptions}
                                ariaLabel={props.copy.taskPrioritySelectAria(task.title)}
                                disabled={props.statusChangeBusy || !props.onTaskPriorityChange}
                                onSave={(taskId, input) => {
                                  if (!props.onTaskPriorityChange) return Promise.reject(new Error(props.appLanguage === 'zh-CN' ? '任务优先级更新能力不可用。' : 'Task priority update is unavailable.'));
                                  return props.onTaskPriorityChange(taskId, input);
                                }}
                              />
                            ) : columnKey === 'intent' ? (
                              <span className="task-table-title-hierarchy" style={{ paddingInlineStart: `${row.depth * 22}px` }}>
                                {props.viewMode === 'hierarchy' ? (
                                  <button
                                    type="button"
                                    className="task-table-hierarchy-toggle"
                                    aria-label={row.hasChildren ? (isEnglishCopy ? `${row.expanded ? 'Collapse' : 'Expand'} ${task.title}` : `${row.expanded ? '收起' : '展开'}${task.title}`) : undefined}
                                    aria-expanded={row.hasChildren ? row.expanded : undefined}
                                    disabled={!row.hasChildren}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (row.hasChildren) props.onToggleTaskExpanded(task.id);
                                    }}
                                  >
                                    <span aria-hidden="true">{row.hasChildren ? (row.expanded ? '▾' : '▸') : '·'}</span>
                                  </button>
                                ) : null}
                                <span className="task-table-title-text">{cell.primary}</span>
                              </span>
                            ) : (
                              <strong>{cell.primary}</strong>
                            )}
                            {cell.secondary ? <small>{cell.secondary}</small> : null}
                          </span>
                        );
                      })}
                    </div>
                  );
                })
              )}
            </section>
          </>
        )}
      </section>
    </section>
  );
}
