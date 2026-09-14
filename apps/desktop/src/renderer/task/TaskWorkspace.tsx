import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { GearSixIcon as GearSix } from '@phosphor-icons/react/dist/csr/GearSix';
import { type TaskBoardFilterGroup, type TaskManagementStatusDefinition } from '@zeus/shared';
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
import { ZeusSelect } from '../ZeusSelect.js';
import {
  createTaskWorkspaceViewModel,
  defaultTaskTableColumnWidths,
  defaultTaskTableColumnOrder,
  defaultVisibleTaskTableColumns,
  formatTaskManagementStatus,
  normalizeTaskTableColumnPreferences,
  resolveTaskAgentRunStatus,
  resolveTaskBranchStatus,
  type TaskAgentRunStatus,
  taskManagementStatuses,
  toggleTaskTableColumn,
} from './taskWorkspaceModel.js';
import { TaskDataTable } from './TaskDataTable.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';
import type { TaskBoardSettingsSection } from './TaskBoardView.js';

const LazyTaskBoardView = lazy(() => import('./TaskBoardView.js').then((module) => ({ default: module.TaskBoardView })));

function countTaskBoardFilterRules(group: TaskBoardFilterGroup | null | undefined): number {
  return group?.conditions.reduce((count, condition) => count + (condition.kind === 'group' ? countTaskBoardFilterRules(condition) : 1), 0) ?? 0;
}

type TaskPriorityEditResult = { kind: 'updated'; task: TaskRecord } | { kind: 'conflict'; latest: TaskRecord };
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
  taskBoardSnapshot?: TaskBoardViewSnapshot | null;
  taskBoardLoading?: boolean;
  taskBoardError?: string | null;
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: TaskStatusFilter) => void;
  onTagFilterChange: (value: string) => void;
  onTaskTableColumnsChange: (value: TaskTableColumnPreferences) => void;
  onSaveTaskTableLayout?: () => void;
  onCreateTask: () => void;
  onOpenTaskDetail: (taskId: string, mode?: TaskBoardOpenMode) => void;
  onOpenTaskConversation?: (taskId: string, conversationId?: string) => void;
  onPageViewModeChange: (viewMode: TaskPageViewMode) => void;
  onReloadTaskBoard?: () => void;
  onUpdateTaskBoard?: (settings: Partial<TaskBoardViewSettings>) => Promise<TaskBoardViewSnapshot>;
  onMoveTaskBoardTask?: (input: TaskBoardMoveRequest) => Promise<{ task: TaskRecord; board: TaskBoardViewSnapshot }>;
  onLoadTaskAttachmentPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
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

function arrayShallowEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function TaskWorkspace(props: TaskWorkspaceProps) {
  const [boardSettingsSection, setBoardSettingsSection] = useState<TaskBoardSettingsSection | null>(null);
  const [bulkTargetStatus, setBulkTargetStatus] = useState<TaskManagementStatus>(() => props.statusDefinitions[0]?.id ?? 'todo');
  useApplicationErrorDialog(props.listState === 'error' ? props.copy.taskListErrorHelp : null, {
    language: props.appLanguage === 'zh-CN' ? 'zh-CN' : 'en',
  });
  /** 原生弹出层使用独立身份，浏览器负责顶层显示、外部点击和 Escape 关闭。 */
  const fieldSettingsId = useId();
  /** 更多动作与列设置分别关联各自的触发按钮。 */
  const moreSettingsId = useId();
  /** 执行动作后关闭原生弹出层。 */
  const moreSettingsPopoverRef = useRef<HTMLElement | null>(null);
  /** 工具条自身变化不重复计算全部任务的筛选、排序和展示字段。 */
  const model = useMemo(
    () =>
      createTaskWorkspaceViewModel({
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
      }),
    [
      props.tasks,
      props.searchQuery,
      props.statusFilter,
      props.tagFilter,
      props.selectedTaskId,
      props.selectedTaskIds,
      props.runtime.aiCli.available,
      props.runtimeSessions,
      props.taskConversations,
      props.conversationRunStatuses,
      props.statusLabels,
      props.statusDefinitions,
      props.completedStatusId,
      props.cancelledStatusId,
      props.runStatusLabels,
      props.projectName,
      props.taskTableColumns,
      props.taskTableEnumSortOrders,
      props.appLanguage,
    ],
  );
  const boardSettings = props.taskBoardSnapshot?.settings;
  const boardFilterCount = countTaskBoardFilterRules(boardSettings?.filters);
  const boardSortCount = boardSettings?.sorts.length ?? 0;
  const boardHiddenCount = (boardSettings?.hiddenGroupIds.length ?? 0) + Object.values(boardSettings?.hiddenSubgroupIdsByGroup ?? {}).reduce((count, ids) => count + ids.length, 0);
  /** 列标题保持稳定，避免表格随普通任务状态更新重建列定义。 */
  const columnLabels = useMemo<Record<TaskTableColumnKey, string>>(
    () => ({
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
    }),
    [props.copy],
  );
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
  const boardRunStatuses = useMemo(
    () => Object.fromEntries(props.tasks.map((task) => [task.id, resolveTaskAgentRunStatus(props.taskConversations?.[task.id] ?? [], props.conversationRunStatuses ?? {})])),
    [props.conversationRunStatuses, props.taskConversations, props.tasks],
  );
  const boardBranchStatuses = useMemo(() => Object.fromEntries(props.tasks.map((task) => [task.id, resolveTaskBranchStatus(props.taskConversations?.[task.id] ?? [])])), [props.taskConversations, props.tasks]);
  const statusSegmentOptions: TaskStatusFilter[] = [...(props.statusOptions.includes('') ? ([''] as const) : []), ...(props.statusOptions.includes('unfinished') ? (['unfinished'] as const) : []), ...bulkStatusOptions].slice(0, 5);
  const isEnglishCopy = props.copy.taskCountPrefix === 'Tasks';
  const showTaskStatusLine = taskListLoading || taskListError;
  const statusLineTitle = taskListLoading ? props.copy.taskListLoadingTitle : props.copy.taskListErrorTitle;
  const statusLineHelp = taskListLoading ? props.copy.taskListLoadingHelp : props.copy.taskListErrorHelp;
  const visibleTaskCountLabel = taskListLoading ? props.copy.taskListLoadingMeta : props.copy.taskListErrorRetry;
  const columnViewActionLabel = isEnglishCopy ? 'Columns' : '列';
  const moreViewActionLabel = isEnglishCopy ? 'More' : '更多';
  const saveViewActionLabel = isEnglishCopy ? 'Save' : '保存';
  const resetColumnsActionLabel = isEnglishCopy ? 'Reset columns' : '恢复默认列';
  /** 一次清空搜索、标签和状态，恢复完整任务列表。 */
  const handleResetTaskFilters = () => {
    props.onSearchChange('');
    props.onTagFilterChange('');
    props.onStatusFilterChange('');
  };
  const filtersHaveValue = Boolean(props.searchQuery.trim() || props.tagFilter.trim() || props.statusFilter);
  const columnsHaveCustomPreferences =
    !arrayShallowEqual(model.columnPreferences.visibleColumnKeys, defaultVisibleTaskTableColumns) ||
    !arrayShallowEqual(model.columnPreferences.columnOrder, defaultTaskTableColumnOrder) ||
    Object.entries(model.columnPreferences.columnWidths ?? {}).some(([columnKey, width]) => width !== defaultTaskTableColumnWidths[columnKey as TaskTableColumnKey]) ||
    Boolean(model.columnPreferences.sort.columnKey);
  const moreActionsAvailable = filtersHaveValue || columnsHaveCustomPreferences;
  /** 清除筛选后收起更多动作。 */
  const handleMoreResetTaskFilters = () => {
    if (!filtersHaveValue) return;
    handleResetTaskFilters();
    moreSettingsPopoverRef.current?.hidePopover();
  };
  /** 恢复列偏好后收起更多动作。 */
  const handleMoreRestoreDefaultColumns = () => {
    if (!columnsHaveCustomPreferences) return;
    props.onTaskTableColumnsChange(normalizeTaskTableColumnPreferences());
    moreSettingsPopoverRef.current?.hidePopover();
  };
  useEffect(() => {
    if (bulkStatusOptions.length === 0 || bulkStatusOptions.includes(bulkTargetStatus)) return;
    setBulkTargetStatus(bulkStatusOptions[0]);
  }, [bulkStatusOptions, bulkTargetStatus]);

  return (
    <section className="task-management-codex-layout task-table-only-layout task-table-layout" aria-label={props.copy.workbenchAria}>
      <section className="task-management-navigation task-table-workbench" aria-label={props.copy.filterAria}>
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
              <>
                {boardFilterCount > 0 ? (
                  <button className="task-table-view-pill task-table-board-state-trigger" type="button" onClick={() => setBoardSettingsSection('rules')}>
                    {isEnglishCopy ? `Filters ${boardFilterCount}` : `筛选 ${boardFilterCount}`}
                  </button>
                ) : null}
                {boardSortCount > 0 ? (
                  <button className="task-table-view-pill task-table-board-state-trigger" type="button" onClick={() => setBoardSettingsSection('rules')}>
                    {isEnglishCopy ? `Sorts ${boardSortCount}` : `排序 ${boardSortCount}`}
                  </button>
                ) : null}
                {boardHiddenCount > 0 ? (
                  <button className="task-table-view-pill task-table-board-state-trigger" type="button" onClick={() => setBoardSettingsSection('layout')}>
                    {isEnglishCopy ? `Hidden ${boardHiddenCount}` : `隐藏 ${boardHiddenCount}`}
                  </button>
                ) : null}
                <button
                  className="task-table-view-pill task-table-board-settings-trigger"
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={boardSettingsSection !== null}
                  aria-label={isEnglishCopy ? 'Board settings' : '看板设置'}
                  title={isEnglishCopy ? 'Board settings' : '看板设置'}
                  onClick={() => setBoardSettingsSection('layout')}
                >
                  <GearSix aria-hidden="true" />
                  <span>{isEnglishCopy ? 'Settings' : '设置'}</span>
                </button>
              </>
            ) : null}
            {props.pageViewMode === 'list' ? (
              <>
                <div className="task-table-field-settings">
                  {/* 列设置保留紧凑入口，通过原生顶层弹出面板展开。 */}
                  <button
                    className="task-table-view-pill task-table-view-pill-strong task-table-field-settings-trigger"
                    type="button"
                    aria-haspopup="dialog"
                    popoverTarget={fieldSettingsId}
                    aria-label={props.copy.fieldSettingsAria}
                    title={props.copy.fieldSettingsAria}
                  >
                    <span className="task-table-field-settings-label">{columnViewActionLabel}</span>
                  </button>
                  <section id={fieldSettingsId} popover="auto" className="task-table-field-settings-popover" role="dialog" aria-label={props.copy.fieldSettingsAria}>
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
                    <button className="task-table-view-pill task-table-more-settings-trigger" type="button" aria-haspopup="menu" popoverTarget={moreSettingsId} disabled={!moreActionsAvailable} aria-disabled={!moreActionsAvailable}>
                      {moreViewActionLabel}
                    </button>
                    {moreActionsAvailable ? (
                      <section ref={moreSettingsPopoverRef} id={moreSettingsId} popover="auto" className="task-table-view-more-panel" role="menu" aria-label={isEnglishCopy ? 'More task view actions' : '更多任务视图动作'}>
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
              settingsOpen={boardSettingsSection !== null}
              settingsSection={boardSettingsSection ?? 'layout'}
              onSettingsOpenChange={(open) => setBoardSettingsSection((current) => (open ? (current ?? 'layout') : null))}
              onSettingsSectionChange={setBoardSettingsSection}
              projectTaskCount={props.tasks.length}
              externalFiltersActive={Boolean(props.searchQuery.trim() || props.statusFilter || props.tagFilter)}
              onCreateTask={props.onCreateTask}
              onClearExternalFilters={() => {
                props.onSearchChange('');
                props.onStatusFilterChange('');
                props.onTagFilterChange('');
              }}
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
            <TaskDataTable key={props.activeProjectId} workspace={props} model={model} labels={columnLabels}>
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
                    </span>
                  ) : null}
                </section>
              ) : null}
            </TaskDataTable>
          </>
        )}
      </section>
    </section>
  );
}
