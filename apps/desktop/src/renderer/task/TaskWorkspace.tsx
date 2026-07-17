import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AiRuntimeSession, RuntimeStatusSnapshot, TaskRecord, TaskStatus, TaskTableColumnKey, TaskTableColumnPreferences, TaskTableColumnWidth } from '../apiClient.js';
import { ZeusSelect } from '../ZeusSelect.js';
import {
  createTaskWorkspaceViewModel,
  defaultTaskTableColumnOrder,
  defaultVisibleTaskTableColumns,
  moveTaskTableColumn,
  normalizeTaskTableColumnPreferences,
  setTaskTableColumnWidth,
  toggleTaskTableColumn,
  type TaskSortKey,
} from './taskWorkspaceModel.js';

export interface TaskWorkspaceCopy {
  filterAria: string;
  searchAria: string;
  searchTitle: string;
  statusAria: string;
  statusSelectAria: string;
  statusTitle: string;
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
  taskCountPrefix: string;
  filteredState: string;
  allState: string;
  codeColumnTitle: string;
  intentColumnTitle: string;
  nextActionColumnTitle: string;
  aiExecutionColumnTitle: string;
  sourceColumnTitle: string;
  signalsColumnTitle: string;
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
}

export type TaskWorkspaceBulkActionStatus = { kind: 'idle' | 'running' | 'done' | 'failed'; message?: string };
export type TaskWorkspaceListState = 'ready' | 'loading' | 'error';

export interface TaskWorkspaceProps {
  projectName?: string;
  tasks: TaskRecord[];
  selectedTaskId?: string;
  selectedTaskIds?: readonly string[];
  searchQuery: string;
  statusFilter: TaskStatus | '';
  tagFilter: string;
  sortBy: TaskSortKey;
  statusOptions: readonly (TaskStatus | '')[];
  sortOptions: readonly TaskSortKey[];
  statusLabels: Record<TaskStatus | '', string>;
  sortLabels: Record<TaskSortKey, string>;
  copy: TaskWorkspaceCopy;
  runtime: RuntimeStatusSnapshot;
  runtimeSessions: AiRuntimeSession[];
  taskTableColumns?: Partial<TaskTableColumnPreferences>;
  creatingTaskBusy: boolean;
  bulkActionBusy?: boolean;
  bulkActionStatus?: TaskWorkspaceBulkActionStatus;
  listState?: TaskWorkspaceListState;
  activeProjectId?: string;
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: TaskStatus | '') => void;
  onTagFilterChange: (value: string) => void;
  onSortChange: (value: TaskSortKey) => void;
  onTaskTableColumnsChange: (value: TaskTableColumnPreferences) => void;
  onCreateTask: () => void;
  onOpenTaskDetail: (taskId: string) => void;
  onToggleTaskSelection?: (taskId: string, selected: boolean) => void;
  onToggleAllVisibleTaskSelection?: (taskIds: string[], selected: boolean) => void;
  onClearTaskSelection?: () => void;
  onBulkTaskStatusChange?: (targetStatus: TaskStatus, taskIds: string[]) => void;
  onBulkTaskDelete?: (taskIds: string[]) => void;
  onRetryTaskList?: () => void;
  onOpenProjectSettings?: () => void;
  onOpenProjectCode?: () => void;
  controlBusyProps: (busy: boolean) => { 'aria-busy'?: true; 'data-loading'?: 'true' };
}

const taskTableColumnGrid: Record<TaskTableColumnKey, string> = {
  code: 'minmax(88px, 0.42fr)',
  intent: 'minmax(168px, 1.1fr)',
  nextAction: 'minmax(96px, 0.5fr)',
  aiExecution: 'minmax(96px, 0.5fr)',
  source: 'minmax(96px, 0.5fr)',
  signals: 'minmax(88px, 0.4fr)',
  updatedAt: 'minmax(112px, 0.5fr)',
  createdAt: 'minmax(112px, 0.5fr)',
  template: 'minmax(128px, 0.55fr)',
  project: 'minmax(128px, 0.55fr)',
  priority: 'minmax(112px, 0.45fr)',
  description: 'minmax(180px, 0.9fr)',
  runtimeSession: 'minmax(160px, 0.72fr)',
  rawId: 'minmax(160px, 0.72fr)',
  createdFrom: 'minmax(128px, 0.52fr)',
};

const taskTableColumnGridByWidth: Record<TaskTableColumnWidth, Record<TaskTableColumnKey, string>> = {
  compact: {
    code: 'minmax(88px, 0.34fr)',
    intent: 'minmax(180px, 1fr)',
    nextAction: 'minmax(112px, 0.52fr)',
    aiExecution: 'minmax(112px, 0.52fr)',
    source: 'minmax(116px, 0.52fr)',
    signals: 'minmax(104px, 0.45fr)',
    updatedAt: 'minmax(112px, 0.42fr)',
    createdAt: 'minmax(112px, 0.42fr)',
    template: 'minmax(104px, 0.42fr)',
    project: 'minmax(104px, 0.42fr)',
    priority: 'minmax(88px, 0.34fr)',
    description: 'minmax(144px, 0.64fr)',
    runtimeSession: 'minmax(128px, 0.56fr)',
    rawId: 'minmax(128px, 0.56fr)',
    createdFrom: 'minmax(104px, 0.42fr)',
  },
  standard: taskTableColumnGrid,
  wide: {
    code: 'minmax(132px, 0.58fr)',
    intent: 'minmax(320px, 1.78fr)',
    nextAction: 'minmax(176px, 0.86fr)',
    aiExecution: 'minmax(176px, 0.86fr)',
    source: 'minmax(184px, 0.86fr)',
    signals: 'minmax(168px, 0.78fr)',
    updatedAt: 'minmax(176px, 0.72fr)',
    createdAt: 'minmax(176px, 0.72fr)',
    template: 'minmax(160px, 0.68fr)',
    project: 'minmax(160px, 0.68fr)',
    priority: 'minmax(136px, 0.56fr)',
    description: 'minmax(240px, 1.12fr)',
    runtimeSession: 'minmax(208px, 0.92fr)',
    rawId: 'minmax(208px, 0.92fr)',
    createdFrom: 'minmax(160px, 0.68fr)',
  },
};

const taskTableColumnWidths: TaskTableColumnWidth[] = ['compact', 'standard', 'wide'];

function getTaskTableColumnTrack(columnKey: TaskTableColumnKey, preferences: TaskTableColumnPreferences): string {
  const width = preferences.columnWidths?.[columnKey] ?? 'standard';
  return taskTableColumnGridByWidth[width]?.[columnKey] ?? taskTableColumnGrid[columnKey];
}

function taskTableCellClassName(columnKey: TaskTableColumnKey, rowCell = false): string {
  const legacyColumnClass: Partial<Record<TaskTableColumnKey, string>> = {
    intent: 'task-table-title-cell',
    nextAction: 'task-table-status-cell',
    signals: 'task-table-tags-cell',
    aiExecution: 'task-table-runtime-cell',
    updatedAt: 'task-table-updated-cell',
  };
  const legacyRowClass: Partial<Record<TaskTableColumnKey, string>> = {
    intent: 'task-list-copy',
    nextAction: 'task-list-meta',
  };
  return ['task-table-cell', legacyColumnClass[columnKey], rowCell ? legacyRowClass[columnKey] : undefined, `task-table-${columnKey}-cell`].filter(Boolean).join(' ');
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
  const [bulkTargetStatus, setBulkTargetStatus] = useState<TaskStatus>(() => props.statusOptions.find((status): status is TaskStatus => Boolean(status)) ?? 'ready');
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
    sortBy: props.sortBy,
    selectedTaskId: props.selectedTaskId,
    selectedTaskIds: props.selectedTaskIds,
    runtimeAiAvailable: props.runtime.aiCli.available,
    runtimeSessions: props.runtimeSessions,
    projectName: props.projectName,
    taskTableColumns: props.taskTableColumns,
  });
  const columnLabels: Record<TaskTableColumnKey, string> = {
    code: props.copy.codeColumnTitle,
    intent: props.copy.intentColumnTitle,
    nextAction: props.copy.nextActionColumnTitle,
    aiExecution: props.copy.aiExecutionColumnTitle,
    source: props.copy.sourceColumnTitle,
    signals: props.copy.signalsColumnTitle,
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
  const bulkStatusOptions = props.statusOptions.filter((status): status is TaskStatus => Boolean(status));
  const bulkTargetEligibility = model.bulkStatusEligibility[bulkTargetStatus];
  const selectedVisibleCount = model.selectedVisibleTaskIds.length;
  const bulkActionBusy = Boolean(props.bulkActionBusy);
  const bulkActionStatus = props.bulkActionStatus ?? { kind: 'idle' as const };
  const taskListState = props.listState ?? 'ready';
  const taskListLoading = taskListState === 'loading';
  const taskListError = taskListState === 'error';
  const showEmptyState = !taskListLoading && !taskListError && model.visibleTasks.length === 0;
  // visual thesis: 任务表格像 macOS 原生工作台，选择列稳定，批量栏只在选择后低噪音出现。
  // content plan: 顶部仍只服务筛选与新建；选择后追加批量状态、删除与结果提示；单任务详情继续收纳到抽屉。
  // interaction thesis: checkbox 只负责选择，行内容负责打开详情，执行反馈通过 aria-live 告知而不打断表格浏览。
  const taskTableContentGridTemplate = model.visibleColumns.map((columnKey) => getTaskTableColumnTrack(columnKey, model.columnPreferences)).join(' ');
  // 动态列由模型偏好决定，并和选择列一起写入单一 CSS 变量，header/row 共用同一条轨道。
  const taskTableGridStyle = {
    '--task-table-grid-template': `minmax(32px, 32px) ${taskTableContentGridTemplate}`,
    gridTemplateColumns: 'var(--task-table-grid-template)',
    minWidth: 'min(100%, 880px)',
  } as CSSProperties & Record<'--task-table-grid-template', string>;
  const hasExpandedTaskTableColumns = model.visibleColumns.length > defaultVisibleTaskTableColumns.length || model.visibleColumns.some((columnKey) => model.columnPreferences.columnWidths?.[columnKey] === 'wide');
  const listClassName = [
    'task-list-workbench task-list-protagonist zeus-source-list',
    showEmptyState ? 'task-list-empty' : undefined,
    taskListLoading ? 'task-list-loading' : undefined,
    taskListError ? 'task-list-error' : undefined,
    !showEmptyState && !taskListLoading && !taskListError && model.visibleTasks.length > 0 && hasExpandedTaskTableColumns ? 'task-list-horizontal-scroll' : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  const metadata =
    taskListLoading || taskListError
      ? `${props.projectName ?? props.copy.noProjectSelected} · ${taskListLoading ? props.copy.taskListLoadingToolbarStatus : props.copy.taskListErrorToolbarStatus}`
      : `${props.projectName ?? props.copy.noProjectSelected} · ${props.copy.taskCountPrefix} ${model.visibleCount}/${model.totalCount} · ${model.hasActiveFilters ? props.copy.filteredState : props.copy.allState}`;
  const statusSegmentOptions = props.statusOptions.filter((status) => status === '' || status === 'ready' || status === 'running').slice(0, 3);
  const isEnglishCopy = props.copy.taskCountPrefix === 'Tasks';
  const viewControlLabel = isEnglishCopy ? 'View controls' : '视图控制';
  const defaultViewLabel = isEnglishCopy ? 'Default view' : '默认视图';
  const emptyStatusLineTitle = model.emptyState === 'no-results' ? props.copy.noResultsTitle : isEnglishCopy ? 'No tasks in this project yet' : '当前项目还没有任务';
  const statusLineTitle = taskListLoading ? props.copy.taskListLoadingTitle : taskListError ? props.copy.taskListErrorTitle : model.visibleCount > 0 ? defaultViewLabel : emptyStatusLineTitle;
  const visibleColumnSummary = model.visibleColumns.map((columnKey) => columnLabels[columnKey]).join(isEnglishCopy ? ', ' : '、');
  const emptyStatusLineHelp =
    model.emptyState === 'no-results'
      ? props.searchQuery.trim()
        ? `${props.copy.searchTitle}: ${props.searchQuery.trim()}`
        : `${props.copy.statusTitle}: ${props.statusLabels[props.statusFilter]}`
      : isEnglishCopy
        ? 'New tasks will appear in the table with task codes.'
        : '创建后会按任务编码进入表格';
  const statusLineHelp = taskListLoading ? props.copy.taskListLoadingHelp : taskListError ? props.copy.taskListErrorHelp : model.visibleCount > 0 ? visibleColumnSummary : emptyStatusLineHelp;
  const visibleTaskCountLabel = taskListLoading ? props.copy.taskListLoadingMeta : taskListError ? props.copy.taskListErrorRetry : isEnglishCopy ? `${model.visibleCount} tasks` : `${model.visibleCount} 项任务`;
  const tagViewLabel = props.tagFilter.trim() || props.statusLabels[''];
  const batchViewActionLabel = isEnglishCopy ? 'Batch' : '批量';
  const columnViewActionLabel = isEnglishCopy ? 'Columns' : '列';
  const moreViewActionLabel = isEnglishCopy ? 'More' : '更多';
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
    Object.values(model.columnPreferences.columnWidths ?? {}).some((width) => width !== 'standard');
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

    // 更多视图控制同样是显式 popover，不使用 details summary，避免恢复浏览器默认三角 chrome。
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

  return (
    <section className="task-management-codex-layout task-table-only-layout task-table-layout" aria-label={props.copy.workbenchAria}>
      <section className="task-management-navigation task-table-workbench" role="grid" aria-label={props.copy.filterAria}>
        <section className="task-filter-workbench task-filter-toolbar task-table-toolbar task-table-primary-toolbar" aria-label={props.copy.filterAria}>
          <span className="task-table-context-meta">{metadata}</span>
          <label className="task-filter-control-row task-filter-search task-toolbar-search" aria-label={props.copy.searchAria}>
            <span className="sr-only">{props.copy.searchTitle}</span>
            <input type="search" aria-label={props.copy.searchAria} placeholder={props.copy.searchTitle} value={props.searchQuery} onChange={(event) => props.onSearchChange(event.currentTarget.value)} />
          </label>
          <div className="task-filter-control-row task-filter-field task-table-status-segments" role="group" aria-label={props.copy.statusAria}>
            <span className="sr-only">{props.copy.statusTitle}</span>
            {statusSegmentOptions.map((status) => (
              <button className="task-table-status-segment" type="button" aria-pressed={props.statusFilter === status} key={status || 'all'} onClick={() => props.onStatusFilterChange(status)}>
                {props.statusLabels[status]}
              </button>
            ))}
          </div>
          <button className="task-table-new-task-button" type="button" onClick={props.onCreateTask} disabled={!props.activeProjectId || props.creatingTaskBusy} {...props.controlBusyProps(props.creatingTaskBusy)}>
            {props.copy.newTask}
          </button>
        </section>
        <section className="task-table-view-toolbar" aria-label={viewControlLabel}>
          <span className="task-table-view-summary">
            <strong>{viewControlLabel}</strong>
            <span>
              {isEnglishCopy ? `: ${props.copy.sortTitle} ` : '：排序 '}
              {props.sortLabels[props.sortBy]}
              {isEnglishCopy ? ` · ${props.copy.tagsTitle} ` : ' · 标签 '}
              {tagViewLabel}
            </span>
          </span>
          <div className="task-table-view-actions" aria-label={isEnglishCopy ? 'Task view actions' : '任务视图动作'}>
            <button
              className="task-table-view-pill task-table-view-bulk-pill"
              type="button"
              disabled={bulkActionBusy || model.visibleTaskIds.length === 0}
              onClick={() => props.onToggleAllVisibleTaskSelection?.(model.visibleTaskIds, !model.allVisibleSelected)}
            >
              {batchViewActionLabel}
            </button>
            <div className="task-table-field-settings">
              {/* 字段配置属于低频视图偏好，必须留在第二层视图控制条，并以 overlay 展开，避免抢占任务页主路径或顶开任务行。 */}
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
                  {model.columnPreferences.columnOrder.map((columnKey, columnIndex) => {
                    const columnTitle = columnLabels[columnKey];
                    const isRequiredColumn = columnKey === 'code' || columnKey === 'intent';
                    const requiredReasonId = `task-table-field-${columnKey}-reason`;
                    const isFirstColumn = columnIndex === 0;
                    const isLastColumn = columnIndex === model.columnPreferences.columnOrder.length - 1;
                    const currentColumnWidth = model.columnPreferences.columnWidths?.[columnKey] ?? 'standard';
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
                        <span className="task-table-field-order-controls" aria-hidden={false}>
                          <button
                            type="button"
                            className="task-table-field-order-button"
                            aria-label={props.copy.moveColumnUpAria(columnTitle)}
                            disabled={isFirstColumn}
                            onClick={() => props.onTaskTableColumnsChange(moveTaskTableColumn(model.columnPreferences, columnKey, 'up'))}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="task-table-field-order-button"
                            aria-label={props.copy.moveColumnDownAria(columnTitle)}
                            disabled={isLastColumn}
                            onClick={() => props.onTaskTableColumnsChange(moveTaskTableColumn(model.columnPreferences, columnKey, 'down'))}
                          >
                            ↓
                          </button>
                        </span>
                        <span className="task-table-field-width-controls" aria-label={`${columnTitle} 列宽`} role="group">
                          {taskTableColumnWidths.map((width) => {
                            const ariaLabel = width === 'compact' ? props.copy.compactColumnAria(columnTitle) : width === 'wide' ? props.copy.wideColumnAria(columnTitle) : props.copy.standardColumnAria(columnTitle);
                            return (
                              <button
                                type="button"
                                className="task-table-field-width-button"
                                aria-label={ariaLabel}
                                aria-pressed={currentColumnWidth === width}
                                data-width={width}
                                key={width}
                                onClick={() => props.onTaskTableColumnsChange(setTaskTableColumnWidth(model.columnPreferences, columnKey, width))}
                              >
                                {width === 'compact' ? '窄' : width === 'wide' ? '宽' : '中'}
                              </button>
                            );
                          })}
                        </span>
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
          </div>
        </section>
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
                ariaLabel={props.copy.bulkStatusTargetAria}
                value={bulkTargetStatus}
                onChange={setBulkTargetStatus}
                searchPlaceholder={props.copy.selectSearchPlaceholder}
                emptyLabel={props.copy.selectNoResults}
                searchable={false}
                options={bulkStatusOptions.map((status) => ({
                  value: status,
                  label: props.statusLabels[status],
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
        <div className="task-table-status-line">
          <span>
            <strong>{statusLineTitle}</strong>
            <span> · {statusLineHelp}</span>
          </span>
          <span>{visibleTaskCountLabel}</span>
        </div>
        <section className={listClassName} role="rowgroup" data-source-list-keyboard="vertical" aria-label={props.copy.today} aria-busy={taskListLoading ? true : undefined} onKeyDown={handleListKeyboardNavigation}>
          {model.visibleColumns.length > 0 ? (
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
              {model.visibleColumns.map((columnKey) => (
                <span className={taskTableCellClassName(columnKey)} role="columnheader" key={columnKey}>
                  {columnLabels[columnKey]}
                </span>
              ))}
            </div>
          ) : null}
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
            // 错误态保持在表格内容区的 inline recovery，不弹窗、不暴露堆栈，也不清空项目导航。
            <section className="project-inline-recovery-row task-list-state-row task-list-error-row" aria-label={props.copy.taskListErrorTitle} role="alert">
              <span className="task-list-state-mark" aria-hidden="true">
                !
              </span>
              <span className="project-inline-recovery-copy task-list-state-copy">
                <strong>{props.copy.taskListErrorTitle}</strong>
                <small>{props.copy.taskListErrorHelp}</small>
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
            // visual thesis: 空任务态只说明下一步，不重复顶部主操作；筛选无结果才显示恢复动作。
            // 任务列表空态必须融入表格工作台底色，不能再用灰色块和额外按钮制造视觉割裂。
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
                  onClick={() => props.onOpenTaskDetail(task.id)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    props.onOpenTaskDetail(task.id);
                  }}
                >
                  {/* 任务列表是任务页布局主角：点击任务行打开详情抽屉，首屏不再塞 Runtime、完成、取消等推进按钮。 */}
                  <span className="task-table-cell task-table-select-cell" role="gridcell" onClick={(event) => event.stopPropagation()}>
                    <TaskSelectionCheckbox ariaLabel={props.copy.selectTaskAria(task.title)} checked={row.bulkSelected} disabled={bulkActionBusy} onChange={(selected) => props.onToggleTaskSelection?.(task.id, selected)} />
                  </span>
                  {model.visibleColumns.map((columnKey) => {
                    const cell = row.cells[columnKey];
                    return (
                      <span className={taskTableCellClassName(columnKey, true)} role="gridcell" key={columnKey}>
                        <strong>{cell.primary}</strong>
                        {cell.secondary ? <small>{cell.secondary}</small> : null}
                      </span>
                    );
                  })}
                </div>
              );
            })
          )}
        </section>
      </section>
    </section>
  );
}
