import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { ChatCircleDotsIcon as ChatCircleDots } from '@phosphor-icons/react/dist/csr/ChatCircleDots';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { GitPullRequestIcon as GitPullRequest } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { AgGridReact, type CustomCellRendererProps } from 'ag-grid-react';
import {
  ClientSideRowModelModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  RowStyleModule,
  themeQuartz,
  type ColDef,
  type ColumnMovedEvent,
  type ColumnResizedEvent,
  type GridApi,
  type IHeaderParams,
  type RowClassRules,
} from 'ag-grid-community';
import { isTaskPriority, type TaskPriority } from '@zeus/shared';
import type { TaskRecord, TaskTableColumnKey } from '../apiClient.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';
import { reportApplicationError } from '../ui/ApplicationErrorDialog.js';
import {
  cycleTaskTableSort,
  defaultTaskTableColumnOrder,
  defaultTaskTableColumnWidths,
  formatTaskManagementStatus,
  taskManagementStatuses,
  getTaskTableColumnWidthBounds,
  normalizeTaskTableColumnPreferences,
  resolveTaskManagementStatus,
  type TaskAgentRunStatus,
  type TaskBranchStatus,
  type TaskRowViewModel,
  type TaskWorkspaceViewModel,
} from './taskWorkspaceModel.js';
import { TaskRunStatusChip, taskBranchStatusTone, taskPriorityTone, taskTypeTone } from './TaskRunStatusChip.js';
import type { TaskWorkspaceProps } from './TaskWorkspace.js';
import './task-data-table.css';

/** 只加载任务列表实际使用的免费模块。 */
const taskTableModules = [ClientSideRowModelModule, ColumnApiModule, ColumnAutoSizeModule, RowStyleModule];
/** 动态规则同时添加和移除选中态，避免已点击行残留高亮。 */
const taskTableRowClassRules: RowClassRules<TaskRowViewModel> = { 'task-data-table-selected': ({ data }) => Boolean(data?.selected) };
/** 表格颜色跟随 Zeus 主题，固定行高确保虚拟滚动无需逐行测量。 */
const taskTableTheme = themeQuartz.withParams({
  backgroundColor: 'var(--zeus-card-background)',
  dataBackgroundColor: 'var(--zeus-card-background)',
  oddRowBackgroundColor: 'var(--zeus-card-background)',
  foregroundColor: 'var(--zeus-product-text)',
  headerBackgroundColor: 'var(--zeus-card-background)',
  headerTextColor: 'var(--zeus-product-muted)',
  borderColor: 'var(--zeus-card-border)',
  accentColor: 'var(--zeus-accent)',
  rowHoverColor: 'color-mix(in srgb, var(--zeus-product-text) 3%, var(--zeus-card-background))',
  fontFamily: 'inherit',
  fontSize: 12,
  headerFontSize: 11,
  rowHeight: 40,
  // 点击单元格不绘制选区蓝框，键盘焦点由表格局部样式单独提示。
  rangeSelectionBorderColor: 'transparent',
  headerHeight: 32,
  cellHorizontalPadding: 10,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  // 连续表面以留白和悬停区分行，表头也不额外画线。
  rowBorder: false,
  headerRowBorder: false,
  columnBorder: false,
  // 调宽提示只在悬停、聚焦或拖动期间显示。
  headerColumnResizeHandleColor: 'var(--zeus-control-accent)',
});

/** 编辑状态位于表格上层，虚拟行卸载不丢失待保存值和冲突事实。 */
type PriorityEdit = { value: string; kind: 'saving' | 'error' | 'conflict'; message?: string; latest?: TaskRecord };
/** 单元格共用当前任务操作和编辑状态，不把业务状态交给表格管理。 */
interface TaskTableContextValue {
  workspace: TaskWorkspaceProps;
  model: TaskWorkspaceViewModel;
  edits: Record<string, PriorityEdit>;
  setEdit: (taskId: string, edit?: PriorityEdit) => void;
}
/** React 上下文让已挂载的行与表头同步实时状态，无需重建列定义。 */
const TaskTableContext = createContext<TaskTableContextValue | null>(null);

/** 所有单元格必须在任务表格内部使用。 */
function useTaskTable(): TaskTableContextValue {
  const context = useContext(TaskTableContext);
  if (!context) throw new Error('任务表格上下文不可用。');
  return context;
}

/** 原生复选框保留部分选中语义，并阻止误打开任务详情。 */
function TaskCheckbox(props: { label: string; checked: boolean; mixed?: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  const checkbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = Boolean(props.mixed);
  }, [props.mixed]);
  return (
    <input
      ref={checkbox}
      type="checkbox"
      aria-label={props.label}
      aria-checked={props.mixed ? 'mixed' : props.checked}
      checked={props.checked}
      disabled={props.disabled}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => props.onChange(event.currentTarget.checked)}
    />
  );
}

/** 全选始终覆盖全部筛选结果，不局限于已渲染的虚拟行。 */
function TaskSelectionHeader() {
  const { workspace, model } = useTaskTable();
  return (
    <TaskCheckbox
      label={workspace.copy.selectAllVisibleTasks}
      checked={model.allVisibleSelected}
      mixed={model.someVisibleSelected && !model.allVisibleSelected}
      disabled={Boolean(workspace.bulkActionBusy) || model.visibleTaskIds.length === 0}
      onChange={(selected) => workspace.onToggleAllVisibleTaskSelection?.(model.visibleTaskIds, selected)}
    />
  );
}

/** 表头复用既有排序规则，拖动和调整列宽由表格负责。 */
function TaskColumnHeader(props: IHeaderParams<TaskRowViewModel>) {
  const { workspace, model } = useTaskTable();
  const columnKey = props.column.getColId() as TaskTableColumnKey;
  const direction = model.columnPreferences.sort.columnKey === columnKey ? model.columnPreferences.sort.direction : null;
  const movedAt = useRef(0);
  useEffect(() => {
    props.eGridHeader.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none');
  }, [direction, props.eGridHeader]);
  useEffect(() => {
    /** 拖列释放时产生的点击不能同时触发排序。 */
    const rememberMove = () => {
      movedAt.current = Date.now();
    };
    props.column.addEventListener('movingChanged', rememberMove);
    return () => props.column.removeEventListener('movingChanged', rememberMove);
  }, [props.column]);
  return (
    <button
      type="button"
      className="task-data-table-sort"
      aria-label={`${props.displayName} · ${workspace.appLanguage === 'zh-CN' ? '点击排序' : 'Sort'}`}
      onClick={() => {
        if (Date.now() - movedAt.current < 150) return;
        workspace.onTaskTableColumnsChange(cycleTaskTableSort(model.columnPreferences, columnKey));
      }}
    >
      <span>{props.displayName}</span>
      {direction ? <span aria-hidden="true">{direction === 'asc' ? '↑' : '↓'}</span> : null}
    </button>
  );
}

/** 优先级反馈放在既有选择器弹层内，保持固定行高且不隐藏冲突操作。 */
function TaskPriorityCell({ task }: { task: TaskRecord }) {
  const { workspace, edits, setEdit } = useTaskTable();
  const statusId = useId();
  const edit = edits[task.id];
  const value = edit?.value ?? task.priority ?? 'p3';
  const zh = workspace.appLanguage === 'zh-CN';
  const feedback = edit?.kind === 'conflict' ? (zh ? '保存冲突' : 'Conflict') : edit?.message;
  /** 按服务器更新时间保存，冲突必须保留用户原值等待明确处理。 */
  async function save(priority: TaskPriority, expectedUpdatedAt: string): Promise<void> {
    if (!expectedUpdatedAt) {
      setEdit(task.id, { value: priority, kind: 'error', message: zh ? '任务缺少更新时间。' : 'Task update time is missing.' });
      return;
    }
    setEdit(task.id, { value: priority, kind: 'saving' });
    try {
      if (!workspace.onTaskPriorityChange) throw new Error(zh ? '任务优先级更新能力不可用。' : 'Task priority update is unavailable.');
      const result = await workspace.onTaskPriorityChange(task.id, { priority, expectedUpdatedAt });
      setEdit(task.id, result.kind === 'conflict' ? { value: priority, kind: 'conflict', latest: result.latest } : undefined);
    } catch (error) {
      setEdit(task.id, { value: priority, kind: 'error', message: reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }) });
    }
  }
  return (
    <span className="task-data-table-priority" aria-busy={edit?.kind === 'saving' || undefined}>
      <ZeusSelect
        size="compact"
        ariaLabel={workspace.copy.taskPrioritySelectAria(task.title)}
        ariaDescribedBy={feedback ? statusId : undefined}
        value={value}
        triggerLabel={`${isTaskPriority(value) ? value.toUpperCase() : zh ? '历史值' : 'Legacy value'}${feedback ? ' !' : ''}`}
        triggerTitle={feedback}
        options={isTaskPriority(value) ? workspace.priorityOptions : [{ value, label: zh ? '历史值' : 'Legacy value', disabled: true }, ...workspace.priorityOptions]}
        onChange={(next) => {
          if (isTaskPriority(next)) void save(next, task.updatedAt ?? '');
        }}
        className={`task-status-select task-priority-select task-status-tone-${taskPriorityTone(value)}`}
        disabled={Boolean(workspace.statusChangeBusy) || !workspace.onTaskPriorityChange || edit?.kind === 'saving'}
        searchable={false}
        footer={
          feedback ? (
            <div className="task-data-table-priority-feedback">
              <span>{feedback}</span>
              <Button
                variant="secondary"
                size="compact"
                onClick={() => {
                  if (isTaskPriority(value)) void save(value, edit?.latest?.updatedAt ?? task.updatedAt ?? '');
                }}
              >
                {zh ? '重试' : 'Retry'}
              </Button>
              {edit?.kind === 'conflict' ? (
                <Button variant="secondary" size="compact" onClick={() => setEdit(task.id)}>
                  {zh ? '载入最新' : 'Load latest'}
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
      />
      {edit?.kind === 'saving' ? <span className="task-save-spinner" aria-hidden="true" /> : null}
      {feedback ? (
        <span id={statusId} className="sr-only" role="status">
          {feedback}
        </span>
      ) : null}
    </span>
  );
}

/** 所有业务单元格沿用原有入口和显示规则。 */
function TaskCell(props: CustomCellRendererProps<TaskRowViewModel>) {
  const { workspace } = useTaskTable();
  const row = props.data;
  if (!row) return null;
  const task = row.task;
  const columnKey = props.column?.getColId() as TaskTableColumnKey | 'selection' | 'actions';
  if (columnKey === 'selection')
    return <TaskCheckbox label={workspace.copy.selectTaskAria(task.title)} checked={row.bulkSelected} disabled={Boolean(workspace.bulkActionBusy)} onChange={(selected) => workspace.onToggleTaskSelection?.(task.id, selected)} />;
  if (columnKey === 'actions') return <TaskActionCell task={task} />;
  const cell = row.cells[columnKey];
  if (columnKey === 'priority') return <TaskPriorityCell task={task} />;
  if (columnKey === 'managementStatus')
    return (
      <ZeusSelect
        size="compact"
        ariaLabel={workspace.copy.taskStatusSelectAria(task.title)}
        value={resolveTaskManagementStatus(task)}
        options={
          workspace.statusDefinitions.length
            ? workspace.statusDefinitions.map((status) => ({ value: status.id, label: workspace.statusLabels[status.id] || status.label || formatTaskManagementStatus(status.id), color: status.color }))
            : taskManagementStatuses.map((value) => ({ value, label: workspace.statusLabels[value] || formatTaskManagementStatus(value) }))
        }
        onChange={(status) => workspace.onTaskStatusChange?.(task.id, status)}
        className="task-status-select task-status-custom"
        style={{ '--task-status-tone': workspace.statusDefinitions.find((status) => status.id === resolveTaskManagementStatus(task))?.color ?? '#6b7280' } as CSSProperties}
        disabled={workspace.statusChangeBusy || !workspace.onTaskStatusChange}
        searchable={false}
      />
    );
  if (columnKey === 'taskType')
    return (
      <span title={cell.primary} className={`task-status-chip task-type-chip task-status-tone-${taskTypeTone(task.taskType)}`}>
        <strong>{cell.primary}</strong>
      </span>
    );
  if (columnKey === 'branchStatus')
    return (
      <span title={cell.primary} className={`task-status-chip task-branch-status-chip task-status-tone-${taskBranchStatusTone(cell.sortValue as TaskBranchStatus)}`}>
        <strong>{cell.primary}</strong>
      </span>
    );
  if (columnKey === 'runStatus')
    return (
      <TaskRunStatusChip
        status={cell.sortValue as TaskAgentRunStatus}
        label={cell.primary}
        ariaLabel={workspace.onOpenTaskConversation ? workspace.copy.openRunStatusConversationAria(task.title, cell.primary) : cell.primary}
        onClick={
          workspace.onOpenTaskConversation
            ? (event) => {
                event.stopPropagation();
                workspace.onOpenTaskConversation?.(task.id, row.runStatusConversationId);
              }
            : undefined
        }
      />
    );
  return (
    <span className="task-data-table-text" title={[cell.primary, cell.secondary].filter(Boolean).join('\n')}>
      {cell.primary}
      {cell.secondary ? <small> · {cell.secondary}</small> : null}
    </span>
  );
}

/** 任务行高频操作沿用 Zeus 的图标按钮，避免打开详情后再寻找入口。 */
function TaskActionCell({ task }: { task: TaskRecord }) {
  const { workspace } = useTaskTable();
  const english = workspace.copy.taskCountPrefix === 'Tasks';
  const entry = workspace.modelPushEntry?.taskId === task.id ? workspace.modelPushEntry : undefined;
  const terminal = resolveTaskManagementStatus(task) === workspace.completedStatusId || resolveTaskManagementStatus(task) === workspace.cancelledStatusId;
  const label = (value: string) => (english ? `${value}: ${task.title}` : `${value}：${task.title}`);
  const pushLabel = entry?.status === 'checking' ? workspace.copy.taskActionChecking : entry?.status === 'error' ? workspace.copy.taskActionRetry : workspace.copy.pushNewConversation;
  return (
    <span className="task-table-row-actions" onClick={(event) => event.stopPropagation()}>
      {workspace.onPushTaskToNewConversation ? (
        <Button
          variant="primary"
          size="compact"
          className="task-table-row-action task-table-row-action-push"
          aria-label={label(pushLabel)}
          title={terminal ? label(workspace.copy.taskActionTerminalHelp) : label(pushLabel)}
          busy={entry?.status === 'checking'}
          disabled={Boolean(workspace.taskActionBusy) || terminal}
          onClick={() => workspace.onPushTaskToNewConversation?.(task.id)}
        >
          {entry?.status === 'checking' ? <CircleNotch aria-hidden="true" weight="regular" /> : entry?.status === 'error' ? <ArrowsClockwise aria-hidden="true" weight="regular" /> : <ChatCircleDots aria-hidden="true" weight="regular" />}
        </Button>
      ) : null}
      {workspace.onOpenTaskCodeDelivery ? (
        <Button
          variant="secondary"
          size="compact"
          className="task-table-row-action"
          aria-label={label(workspace.copy.taskActionCodeDelivery)}
          title={label(workspace.copy.taskActionCodeDelivery)}
          disabled={Boolean(workspace.taskActionBusy)}
          onClick={() => workspace.onOpenTaskCodeDelivery?.(task.id)}
        >
          <GitPullRequest aria-hidden="true" weight="regular" />
        </Button>
      ) : null}
      {workspace.onDeleteTask ? (
        <Button
          variant="danger"
          size="compact"
          className="task-table-row-action"
          aria-label={label(workspace.copy.taskActionDelete)}
          title={label(workspace.copy.taskActionDelete)}
          disabled={Boolean(workspace.taskActionBusy)}
          onClick={() => workspace.onDeleteTask?.(task.id)}
        >
          <Trash aria-hidden="true" weight="regular" />
        </Button>
      ) : null}
    </span>
  );
}

/** 单元格内部控件保留原生按键，Tab 可进入与离开自定义按钮。 */
function suppressTaskControlKeys(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (event.key === 'Tab') {
    const cell = target.closest('.ag-cell, .ag-header-cell');
    const controls = Array.from(cell?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []);
    const index = controls.indexOf(target);
    const next = event.shiftKey ? controls[index - 1] : controls[index + 1];
    if (next) {
      event.preventDefault();
      next.focus();
      return true;
    }
    return false;
  }
  return Boolean(target.closest('button, input'));
}

/** 任务专用数据表格；筛选、排序和选中事实均来自现有视图模型。 */
export function TaskDataTable({ workspace, model, labels, children }: { workspace: TaskWorkspaceProps; model: TaskWorkspaceViewModel; labels: Record<TaskTableColumnKey, string>; children?: ReactNode }) {
  const grid = useRef<GridApi<TaskRowViewModel> | null>(null);
  /** 实时任务更新不重复向表格应用相同的列布局。 */
  const layout = useMemo(() => normalizeTaskTableColumnPreferences(workspace.taskTableColumns), [workspace.taskTableColumns]);
  const [edits, setEdits] = useState<Record<string, PriorityEdit>>({});
  const context = useMemo<TaskTableContextValue>(
    () => ({
      workspace,
      model,
      edits,
      setEdit: (taskId, edit) =>
        setEdits((current) => {
          const next = { ...current };
          if (edit) next[taskId] = edit;
          else delete next[taskId];
          return next;
        }),
    }),
    [workspace, model, edits],
  );
  const columns = useMemo<ColDef<TaskRowViewModel>[]>(
    () => [
      { colId: 'selection', width: 40, minWidth: 40, maxWidth: 40, resizable: false, suppressMovable: true, lockPosition: 'left', headerComponent: TaskSelectionHeader, cellRenderer: TaskCell },
      ...defaultTaskTableColumnOrder.map(
        (key): ColDef<TaskRowViewModel> => ({
          colId: key,
          headerName: labels[key],
          initialWidth: defaultTaskTableColumnWidths[key],
          minWidth: getTaskTableColumnWidthBounds(key).min,
          maxWidth: getTaskTableColumnWidthBounds(key).max,
          headerComponent: TaskColumnHeader,
          cellRenderer: TaskCell,
        }),
      ),
      ...(workspace.onPushTaskToNewConversation || workspace.onOpenTaskCodeDelivery || workspace.onDeleteTask
        ? [{ colId: 'actions', headerName: workspace.copy.actionsColumnTitle, initialWidth: 150, minWidth: 120, maxWidth: 220, cellRenderer: TaskCell }]
        : []),
    ],
    [labels, workspace.copy.actionsColumnTitle, workspace.onDeleteTask, workspace.onOpenTaskCodeDelivery, workspace.onPushTaskToNewConversation],
  );
  const defaults = useMemo<ColDef<TaskRowViewModel>>(
    () => ({ resizable: true, sortable: false, suppressHeaderMenuButton: true, suppressKeyboardEvent: ({ event }) => suppressTaskControlKeys(event), suppressHeaderKeyboardEvent: ({ event }) => suppressTaskControlKeys(event) }),
    [],
  );
  /** 读取布局草稿时不回写，只有用户完成拖动或缩放才改变草稿。 */
  function applyLayout(api: GridApi<TaskRowViewModel>): void {
    api.applyColumnState({
      state: [{ colId: 'selection' }, ...layout.columnOrder.map((key) => ({ colId: key, hide: !layout.visibleColumnKeys.includes(key), width: layout.columnWidths?.[key] ?? defaultTaskTableColumnWidths[key] }))],
      applyOrder: true,
    });
  }
  useEffect(() => {
    if (grid.current && !grid.current.isDestroyed()) applyLayout(grid.current);
  }, [layout]);
  /** 保存完整列顺序和宽度，沿用项目级及全局级的既有持久化入口。 */
  function saveLayout(event: ColumnMovedEvent<TaskRowViewModel> | ColumnResizedEvent<TaskRowViewModel>): void {
    if (!event.finished || !['uiColumnMoved', 'uiColumnDragged', 'uiColumnResized', 'autosizeColumns'].includes(event.source)) return;
    const state = event.api.getColumnState().filter((column) => column.colId !== 'selection' && column.colId !== 'actions');
    workspace.onTaskTableColumnsChange(
      normalizeTaskTableColumnPreferences({ ...model.columnPreferences, columnOrder: state.map((column) => column.colId), columnWidths: Object.fromEntries(state.map((column) => [column.colId, column.width])) }),
    );
  }
  return (
    <TaskTableContext.Provider value={context}>
      <div className="task-data-table" aria-label={workspace.copy.today} aria-busy={workspace.listState === 'loading' || undefined}>
        <AgGridReact<TaskRowViewModel>
          modules={taskTableModules}
          theme={taskTableTheme}
          columnDefs={columns}
          defaultColDef={defaults}
          rowData={workspace.listState && workspace.listState !== 'ready' ? [] : model.rows}
          getRowId={({ data }) => data.id}
          rowHeight={40}
          headerHeight={32}
          rowBuffer={10}
          animateRows={false}
          suppressScrollOnNewData
          suppressNoRowsOverlay
          suppressDragLeaveHidesColumns
          rowClassRules={taskTableRowClassRules}
          onGridReady={({ api }) => {
            grid.current = api;
            applyLayout(api);
          }}
          onColumnMoved={saveLayout}
          onColumnResized={saveLayout}
          onRowClicked={({ data, event }) => {
            if (data && !(event?.target instanceof Element && event.target.closest('button, input, a'))) workspace.onOpenTaskDetail(data.id);
          }}
          onCellKeyDown={({ data, event }) => {
            if (data && event instanceof KeyboardEvent && ['Enter', ' '].includes(event.key) && !(event.target instanceof Element && event.target.closest('button, input, a'))) {
              event.preventDefault();
              workspace.onOpenTaskDetail(data.id);
            }
          }}
        />
        {children ? <div className="task-data-table-overlay">{children}</div> : null}
      </div>
    </TaskTableContext.Provider>
  );
}
