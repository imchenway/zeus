import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type ScreenReaderInstructions,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { DotsSixVerticalIcon as DotsSixVertical } from '@phosphor-icons/react/dist/csr/DotsSixVertical';
import { EyeSlashIcon as EyeSlash } from '@phosphor-icons/react/dist/csr/EyeSlash';
import {
  taskBoardCardProperties,
  taskBoardEmptyGroupId,
  taskBoardGroupProperties,
  type TaskBoardCardProperty,
  type TaskBoardColorTone,
  type TaskBoardFilterGroup,
  type TaskBoardFilterOperator,
  type TaskBoardFilterRule,
  type TaskBoardGroupProperty,
  type TaskBoardMoveRequest,
  type TaskBoardOpenMode,
  type TaskBoardViewSettings,
  type TaskBoardViewSnapshot,
  type TaskManagementStatusDefinition,
} from '@zeus/shared';
import { memo, useEffect, useId, useMemo, useState, type CSSProperties } from 'react';
import type { TaskAgentRunStatus, TaskRecord } from '../apiClient.js';
import { Button } from '../ui/Button.js';
import { formatVisibleApplicationError, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { parseTaskAttachments } from './taskAttachments.js';
import { buildTaskBoardGroups, taskBoardActiveContent, taskBoardCardPropertyValues, taskBoardGroupOptions, type TaskBoardCardModel, type TaskBoardGroupModel, type TaskBoardProjectionContext } from './taskBoardModel.js';
import { formatTaskType, type TaskBranchStatus } from './taskWorkspaceModel.js';
import { taskBranchStatusTone, taskPriorityTone, taskRunStatusTone, taskTypeTone, type TaskSemanticTone } from './TaskRunStatusChip.js';

export interface TaskBoardViewProps {
  projectId: string;
  language: 'zh-CN' | 'en-US';
  tasks: TaskRecord[];
  snapshot: TaskBoardViewSnapshot | null;
  loading: boolean;
  error: string | null;
  statusDefinitions: readonly TaskManagementStatusDefinition[];
  runStatuses: Record<string, TaskAgentRunStatus | undefined>;
  branchStatuses: Record<string, TaskBranchStatus | undefined>;
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
  onReload: () => void;
  onUpdateSettings: (settings: Partial<TaskBoardViewSettings>) => Promise<TaskBoardViewSnapshot>;
  onMoveTask: (input: TaskBoardMoveRequest) => Promise<{ task: TaskRecord; board: TaskBoardViewSnapshot }>;
  onOpenTask: (taskId: string, mode: TaskBoardOpenMode) => void;
  onLoadAttachmentPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
}

type DragData = { kind: 'group'; groupId: string } | { kind: 'lane'; groupId: string; subgroupId: string } | { kind: 'card'; card: TaskBoardCardModel };

const taskBoardCollisionDetection: CollisionDetection = (args) => {
  const activeData = args.active.data.current as DragData | undefined;
  const droppableContainers = args.droppableContainers.filter((container) => {
    const data = container.data.current as DragData | undefined;
    if (activeData?.kind === 'group') return data?.kind === 'group';
    if (activeData?.kind === 'card') return data?.kind === 'card' || data?.kind === 'lane';
    return false;
  });
  return closestCenter({ ...args, droppableContainers });
};

function reorderVisibleGroupIds(settings: TaskBoardViewSettings, availableGroupIds: string[], visibleGroupIds: string[], sourceId: string, targetId: string): string[] {
  const visibleOrder = [...visibleGroupIds];
  const sourceIndex = visibleOrder.indexOf(sourceId);
  const targetIndex = visibleOrder.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) return settings.groupOrder;
  visibleOrder.splice(targetIndex, 0, visibleOrder.splice(sourceIndex, 1)[0]!);
  const visibleSet = new Set(visibleOrder);
  const fullOrder = Array.from(new Set([...settings.groupOrder, ...availableGroupIds]));
  let nextVisibleIndex = 0;
  return fullOrder.map((groupId) => (visibleSet.has(groupId) ? visibleOrder[nextVisibleIndex++]! : groupId));
}

const groupPropertyLabels: Record<TaskBoardGroupProperty, [string, string]> = {
  managementStatus: ['任务状态', 'Task status'],
  priority: ['优先级', 'Priority'],
  taskType: ['任务类型', 'Task type'],
  tags: ['标签', 'Tags'],
  parentTask: ['父任务', 'Parent task'],
  runStatus: ['执行状态', 'Run status'],
  branchStatus: ['分支状态', 'Branch status'],
  source: ['任务来源', 'Source'],
};

const cardPropertyLabels: Record<TaskBoardCardProperty, [string, string]> = {
  code: ['任务编号', 'Task code'],
  managementStatus: ['任务状态', 'Task status'],
  priority: ['优先级', 'Priority'],
  taskType: ['任务类型', 'Task type'],
  runStatus: ['执行状态', 'Run status'],
  branchStatus: ['分支状态', 'Branch status'],
  tags: ['标签', 'Tags'],
  parentTask: ['父任务', 'Parent task'],
  source: ['任务来源', 'Source'],
  createdAt: ['创建时间', 'Created'],
  updatedAt: ['更新时间', 'Updated'],
};

const filterOperators: Array<{ value: TaskBoardFilterOperator; label: [string, string] }> = [
  { value: 'equals', label: ['等于', 'Equals'] },
  { value: 'not_equals', label: ['不等于', 'Does not equal'] },
  { value: 'contains', label: ['包含', 'Contains'] },
  { value: 'not_contains', label: ['不包含', 'Does not contain'] },
  { value: 'is_empty', label: ['为空', 'Is empty'] },
  { value: 'is_not_empty', label: ['不为空', 'Is not empty'] },
];

function translate(pair: [string, string], language: TaskBoardViewProps['language']): string {
  return pair[language === 'zh-CN' ? 0 : 1];
}

function transformStyle(transform: { x: number; y: number; scaleX?: number; scaleY?: number } | null, transition?: string): CSSProperties {
  return {
    transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0) scaleX(${transform.scaleX ?? 1}) scaleY(${transform.scaleY ?? 1})` : undefined,
    transition,
  };
}

function taskBoardPropertyLabel(property: TaskBoardCardProperty, task: TaskRecord, context: TaskBoardProjectionContext): string {
  const values = taskBoardCardPropertyValues(task, property, context);
  if (property === 'taskType') return formatTaskType(task.taskType, context.language);
  if (property === 'managementStatus') return new Map(taskBoardGroupOptions(context, 'managementStatus').map((option) => [option.id, option.label])).get(values[0] ?? '') ?? values[0] ?? '—';
  if (property === 'priority') return values[0]?.toUpperCase() ?? '—';
  if (property === 'parentTask') return context.tasks.find((candidate) => candidate.id === values[0])?.title ?? (context.language === 'zh-CN' ? '无父任务' : 'No parent task');
  if (property === 'tags') return values[0] === taskBoardEmptyGroupId ? (context.language === 'zh-CN' ? '无标签' : 'No tags') : values.join(' · ');
  if (property === 'runStatus' || property === 'branchStatus' || property === 'source') {
    const options = new Map(taskBoardGroupOptions(context, property).map((option) => [option.id, option.label]));
    return values.map((value) => options.get(value) ?? value).join(' · ');
  }
  if (property === 'createdAt' || property === 'updatedAt') {
    const value = values[0];
    return value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(context.language, { dateStyle: 'medium' }).format(Date.parse(value)) : '—';
  }
  return values.filter((value) => value !== taskBoardEmptyGroupId).join(' · ') || '—';
}

/** 卡片属性胶囊的语义配色：任务状态跟随用户自定义主色，其余属性复用全应用统一的语义色调，保持与任务列表一致。 */
function taskBoardPropertyAccent(property: TaskBoardCardProperty, task: TaskRecord, context: TaskBoardProjectionContext): { tone: TaskSemanticTone; color?: string } {
  if (property === 'managementStatus') {
    const color = context.statusDefinitions.find((status) => status.id === (task.managementStatus ?? 'todo'))?.color;
    return { tone: 'neutral', color };
  }
  if (property === 'priority') return { tone: taskPriorityTone(task.priority ?? null) };
  if (property === 'taskType') return { tone: taskTypeTone(task.taskType) };
  if (property === 'runStatus') return { tone: taskRunStatusTone(context.runStatuses[task.id] ?? 'not_started') };
  if (property === 'branchStatus') return { tone: taskBranchStatusTone(context.branchStatuses[task.id] ?? 'not_created') };
  return { tone: 'neutral' };
}

function TaskBoardImagePreview(props: { task: TaskRecord; settings: TaskBoardViewSettings; loadPreview?: TaskBoardViewProps['onLoadAttachmentPreview'] }) {
  const image = parseTaskAttachments(props.task.sourceContextJson).find((attachment) => attachment.kind === 'image');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(null);
    if (!image || !props.loadPreview) return;
    void props.loadPreview(image.path).then((preview) => {
      if (!cancelled) setPreviewUrl(preview?.previewUrl ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [image?.path, props.loadPreview]);
  if (!image || !previewUrl) return null;
  const position = props.settings.previewPositions[props.task.id] ?? { x: 50, y: 50 };
  return <img className="task-board-card-preview-image" src={previewUrl} alt={image.name} style={{ objectFit: props.settings.fitPreview ? 'cover' : 'contain', objectPosition: `${position.x}% ${position.y}%` }} />;
}

const TaskBoardCard = memo(function TaskBoardCard(props: {
  card: TaskBoardCardModel;
  context: TaskBoardProjectionContext;
  settings: TaskBoardViewSettings;
  laneOptions: Array<{ value: string; label: string }>;
  busy: boolean;
  dropPosition: 'before' | 'after' | null;
  onMoveToLane: (card: TaskBoardCardModel, laneValue: string) => void;
  onOpenTask: TaskBoardViewProps['onOpenTask'];
  loadPreview?: TaskBoardViewProps['onLoadAttachmentPreview'];
}) {
  const sortable = useSortable({ id: props.card.occurrenceId, data: { kind: 'card', card: props.card } satisfies DragData, disabled: props.busy });
  const visibleProperties = props.settings.propertyOrder.filter((property) => props.settings.visibleProperties.includes(property));
  return (
    <article
      ref={sortable.setNodeRef}
      className={`task-board-card task-board-card-${props.settings.cardSize} task-board-card-tone-${props.card.tone}${sortable.isDragging ? ' is-dragging' : ''}${sortable.isOver && props.dropPosition ? ` is-over is-over-${props.dropPosition}` : ''}`}
      style={transformStyle(sortable.transform, sortable.transition)}
      data-task-id={props.card.task.id}
    >
      {props.settings.preview === 'first_image' ? <TaskBoardImagePreview task={props.card.task} settings={props.settings} loadPreview={props.loadPreview} /> : null}
      {props.settings.preview === 'content' && taskBoardActiveContent(props.card.task) ? <p className="task-board-card-content-preview">{taskBoardActiveContent(props.card.task)}</p> : null}
      <div className="task-board-card-heading">
        <button
          type="button"
          className="task-board-card-open"
          onClick={() => props.onOpenTask(props.card.task.id, props.settings.openMode)}
          aria-label={`${props.context.language === 'zh-CN' ? '打开任务' : 'Open task'} ${props.card.task.title}`}
        >
          {props.card.task.title}
        </button>
        <button
          ref={sortable.setActivatorNodeRef}
          type="button"
          className="task-board-drag-handle"
          aria-label={`${props.context.language === 'zh-CN' ? '拖动任务' : 'Drag task'} ${props.card.task.title}`}
          disabled={props.busy}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <DotsSixVertical aria-hidden="true" weight="bold" />
        </button>
      </div>
      <div className="task-board-card-properties">
        {visibleProperties.map((property) => {
          const accent = taskBoardPropertyAccent(property, props.card.task, props.context);
          const toned = Boolean(accent.color) || accent.tone !== 'neutral';
          return (
            <span
              className={`task-board-card-property task-board-card-property-${property}${toned ? ` is-toned task-board-card-property-tone-${accent.tone}` : ''}`}
              style={accent.color ? ({ '--task-board-property-color': accent.color } as CSSProperties) : undefined}
              key={property}
              title={translate(cardPropertyLabels[property], props.context.language)}
            >
              <small>{translate(cardPropertyLabels[property], props.context.language)}</small>
              <span>{taskBoardPropertyLabel(property, props.card.task, props.context)}</span>
            </span>
          );
        })}
      </div>
      <label className="task-board-move-menu">
        <span className="sr-only">{props.context.language === 'zh-CN' ? '移动到分组' : 'Move to group'}</span>
        <ArrowRight aria-hidden="true" weight="bold" />
        <select
          aria-label={`${props.context.language === 'zh-CN' ? '移动任务' : 'Move task'} ${props.card.task.title}`}
          value=""
          disabled={props.busy}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value) props.onMoveToLane(props.card, value);
          }}
        >
          <option value="">{props.context.language === 'zh-CN' ? '移动到…' : 'Move to…'}</option>
          {props.laneOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </article>
  );
});

function TaskBoardLane(props: {
  group: TaskBoardGroupModel;
  subgroupId: string;
  label?: string;
  cards: TaskBoardCardModel[];
  calculation: string;
  context: TaskBoardProjectionContext;
  settings: TaskBoardViewSettings;
  laneOptions: Array<{ value: string; label: string }>;
  collapsed: boolean;
  busy: boolean;
  activeCardOccurrenceId: string | null;
  onToggleCollapsed?: () => void;
  onHide?: () => void;
  onMoveToLane: (card: TaskBoardCardModel, laneValue: string) => void;
  onOpenTask: TaskBoardViewProps['onOpenTask'];
  loadPreview?: TaskBoardViewProps['onLoadAttachmentPreview'];
}) {
  const laneId = `lane:${props.group.id}:${props.subgroupId}`;
  const droppable = useDroppable({ id: laneId, data: { kind: 'lane', groupId: props.group.id, subgroupId: props.subgroupId } satisfies DragData });
  return (
    <section ref={droppable.setNodeRef} className={`task-board-lane${droppable.isOver ? ' is-over' : ''}${props.collapsed ? ' is-collapsed' : ''}`} aria-label={props.label ?? props.group.label}>
      {props.label ? (
        <header className="task-board-subgroup-heading">
          <button type="button" onClick={props.onToggleCollapsed} aria-expanded={!props.collapsed}>
            {props.collapsed ? <CaretRight aria-hidden="true" weight="bold" /> : <CaretDown aria-hidden="true" weight="bold" />}
            {props.label}
          </button>
          <span className="task-board-subgroup-actions">
            <span>{props.context.language === 'zh-CN' ? `${props.cards.length} 项` : `${props.cards.length} items`}</span>
            <button type="button" aria-label={`${props.context.language === 'zh-CN' ? '隐藏子分组' : 'Hide subgroup'} ${props.label}`} onClick={props.onHide}>
              <EyeSlash aria-hidden="true" />
            </button>
          </span>
        </header>
      ) : null}
      {!props.collapsed ? (
        <>
          <SortableContext items={props.cards.map((card) => card.occurrenceId)} strategy={verticalListSortingStrategy}>
            <div className="task-board-card-stack">
              {props.cards.map((card, cardIndex) => (
                <TaskBoardCard
                  key={card.occurrenceId}
                  card={card}
                  context={props.context}
                  settings={props.settings}
                  laneOptions={props.laneOptions}
                  busy={props.busy}
                  dropPosition={
                    props.activeCardOccurrenceId === card.occurrenceId
                      ? null
                      : props.cards.findIndex((entry) => entry.occurrenceId === props.activeCardOccurrenceId) >= 0 && props.cards.findIndex((entry) => entry.occurrenceId === props.activeCardOccurrenceId) < cardIndex
                        ? 'after'
                        : 'before'
                  }
                  onMoveToLane={props.onMoveToLane}
                  onOpenTask={props.onOpenTask}
                  loadPreview={props.loadPreview}
                />
              ))}
              {props.cards.length === 0 ? <span className="task-board-empty-lane">{props.context.language === 'zh-CN' ? '暂无任务' : 'No tasks'}</span> : null}
            </div>
          </SortableContext>
          <footer className="task-board-lane-calculation">
            <span>{props.context.language === 'zh-CN' ? '统计' : 'Calculate'}</span>
            <strong>{props.calculation}</strong>
          </footer>
        </>
      ) : null}
    </section>
  );
}

function TaskBoardColumn(props: {
  group: TaskBoardGroupModel;
  context: TaskBoardProjectionContext;
  settings: TaskBoardViewSettings;
  laneOptions: Array<{ value: string; label: string }>;
  busy: boolean;
  activeCardOccurrenceId: string | null;
  groupDropPosition: 'before' | 'after' | null;
  onSettingsChange: (settings: Partial<TaskBoardViewSettings>) => void;
  onMoveToLane: (card: TaskBoardCardModel, laneValue: string) => void;
  onOpenTask: TaskBoardViewProps['onOpenTask'];
  loadPreview?: TaskBoardViewProps['onLoadAttachmentPreview'];
}) {
  const sortable = useSortable({ id: `group:${props.group.id}`, data: { kind: 'group', groupId: props.group.id } satisfies DragData, disabled: props.busy || props.settings.groupSort !== 'manual' });
  const collapsed = props.settings.collapsedGroupIds.includes(props.group.id);
  const columnTone = props.settings.colorColumns ? props.settings.columnColors[props.group.id] : undefined;
  const columnStyle: CSSProperties = {
    ...transformStyle(sortable.transform, sortable.transition),
    ...(props.settings.colorColumns && !columnTone && props.group.color ? ({ '--task-board-group-color': props.group.color } as CSSProperties) : {}),
  };
  return (
    <section
      ref={sortable.setNodeRef}
      className={`task-board-column${columnTone ? ` task-board-column-tone-${columnTone}` : ''}${collapsed ? ' is-collapsed' : ''}${sortable.isDragging ? ' is-dragging' : ''}${sortable.isOver && props.groupDropPosition ? ` is-over is-over-${props.groupDropPosition}` : ''}`}
      style={columnStyle}
    >
      <header className="task-board-column-heading">
        <button
          type="button"
          className="task-board-column-collapse"
          aria-expanded={!collapsed}
          onClick={() =>
            props.onSettingsChange({
              collapsedGroupIds: collapsed ? props.settings.collapsedGroupIds.filter((id) => id !== props.group.id) : [...props.settings.collapsedGroupIds, props.group.id],
            })
          }
        >
          <span className="task-board-group-dot" aria-hidden="true" />
          <span>{props.group.label}</span>
          <small>{props.context.language === 'zh-CN' ? `${props.group.taskCount} 项` : `${props.group.taskCount} items`}</small>
          {collapsed ? <CaretRight className="task-board-column-caret" aria-hidden="true" /> : <CaretDown className="task-board-column-caret" aria-hidden="true" />}
        </button>
        <button
          ref={sortable.setActivatorNodeRef}
          type="button"
          className="task-board-column-drag-handle"
          aria-label={`${props.context.language === 'zh-CN' ? '拖动分组' : 'Drag group'} ${props.group.label}`}
          disabled={props.busy || props.settings.groupSort !== 'manual'}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <DotsSixVertical aria-hidden="true" weight="bold" />
        </button>
        <button
          type="button"
          className="task-board-column-hide"
          aria-label={`${props.context.language === 'zh-CN' ? '隐藏分组' : 'Hide group'} ${props.group.label}`}
          onClick={() => props.onSettingsChange({ hiddenGroupIds: [...props.settings.hiddenGroupIds, props.group.id] })}
        >
          <EyeSlash aria-hidden="true" />
        </button>
      </header>
      {!collapsed ? (
        props.settings.subgroupBy ? (
          <div className="task-board-subgroups">
            {props.group.subgroups.map((subgroup) => {
              const collapsedSubgroups = props.settings.collapsedSubgroupIdsByGroup[props.group.id] ?? [];
              const subgroupCollapsed = collapsedSubgroups.includes(subgroup.id);
              return (
                <TaskBoardLane
                  key={subgroup.id}
                  group={props.group}
                  subgroupId={subgroup.id}
                  label={subgroup.label}
                  cards={subgroup.cards}
                  calculation={subgroup.calculation}
                  context={props.context}
                  settings={props.settings}
                  laneOptions={props.laneOptions}
                  collapsed={subgroupCollapsed}
                  busy={props.busy}
                  activeCardOccurrenceId={props.activeCardOccurrenceId}
                  onToggleCollapsed={() =>
                    props.onSettingsChange({
                      collapsedSubgroupIdsByGroup: {
                        ...props.settings.collapsedSubgroupIdsByGroup,
                        [props.group.id]: subgroupCollapsed ? collapsedSubgroups.filter((id) => id !== subgroup.id) : [...collapsedSubgroups, subgroup.id],
                      },
                    })
                  }
                  onHide={() =>
                    props.onSettingsChange({
                      hiddenSubgroupIdsByGroup: {
                        ...props.settings.hiddenSubgroupIdsByGroup,
                        [props.group.id]: [...(props.settings.hiddenSubgroupIdsByGroup[props.group.id] ?? []), subgroup.id],
                      },
                    })
                  }
                  onMoveToLane={props.onMoveToLane}
                  onOpenTask={props.onOpenTask}
                  loadPreview={props.loadPreview}
                />
              );
            })}
            {props.group.subgroups.length === 0 ? (
              <span className="task-board-empty-subgroups">{props.context.language === 'zh-CN' ? '子分组已隐藏或当前为空，可在看板设置中恢复。' : 'Subgroups are hidden or empty. Restore them in board settings.'}</span>
            ) : null}
          </div>
        ) : (
          <TaskBoardLane
            group={props.group}
            subgroupId=""
            cards={props.group.cards}
            calculation={props.group.calculation}
            context={props.context}
            settings={props.settings}
            laneOptions={props.laneOptions}
            collapsed={false}
            busy={props.busy}
            activeCardOccurrenceId={props.activeCardOccurrenceId}
            onMoveToLane={props.onMoveToLane}
            onOpenTask={props.onOpenTask}
            loadPreview={props.loadPreview}
          />
        )
      ) : null}
    </section>
  );
}

function newFilterRule(): TaskBoardFilterRule {
  return { id: crypto.randomUUID(), kind: 'rule', property: 'managementStatus', operator: 'equals', value: '' };
}

function newFilterGroup(): TaskBoardFilterGroup {
  return { id: crypto.randomUUID(), kind: 'group', conjunction: 'and', conditions: [newFilterRule()] };
}

function TaskBoardFilterEditor(props: { group: TaskBoardFilterGroup; depth: number; language: TaskBoardViewProps['language']; onChange: (group: TaskBoardFilterGroup) => void; onRemove?: () => void }) {
  const zh = props.language === 'zh-CN';
  return (
    <div className="task-board-filter-group" data-depth={props.depth}>
      <div className="task-board-filter-group-heading">
        <select aria-label={zh ? '筛选组合方式' : 'Filter conjunction'} value={props.group.conjunction} onChange={(event) => props.onChange({ ...props.group, conjunction: event.currentTarget.value === 'or' ? 'or' : 'and' })}>
          <option value="and">{zh ? '同时满足' : 'All'}</option>
          <option value="or">{zh ? '满足任一' : 'Any'}</option>
        </select>
        <Button variant="secondary" size="compact" onClick={() => props.onChange({ ...props.group, conditions: [...props.group.conditions, newFilterRule()] })}>
          {zh ? '添加条件' : 'Add condition'}
        </Button>
        {props.depth < 3 ? (
          <Button variant="secondary" size="compact" onClick={() => props.onChange({ ...props.group, conditions: [...props.group.conditions, newFilterGroup()] })}>
            {zh ? '添加条件组' : 'Add group'}
          </Button>
        ) : null}
        {props.onRemove ? (
          <Button variant="secondary" size="compact" onClick={props.onRemove}>
            {zh ? '移除条件组' : 'Remove group'}
          </Button>
        ) : null}
      </div>
      {props.group.conditions.map((condition, index) =>
        condition.kind === 'group' ? (
          <TaskBoardFilterEditor
            key={condition.id}
            group={condition}
            depth={props.depth + 1}
            language={props.language}
            onChange={(group) => props.onChange({ ...props.group, conditions: props.group.conditions.map((entry, entryIndex) => (entryIndex === index ? group : entry)) })}
            onRemove={() => props.onChange({ ...props.group, conditions: props.group.conditions.filter((_, entryIndex) => entryIndex !== index) })}
          />
        ) : (
          <div className="task-board-filter-rule" key={condition.id}>
            <select
              aria-label={zh ? '筛选字段' : 'Filter property'}
              value={condition.property}
              onChange={(event) =>
                props.onChange({
                  ...props.group,
                  conditions: props.group.conditions.map((entry, entryIndex) => (entryIndex === index && entry.kind === 'rule' ? { ...entry, property: event.currentTarget.value as TaskBoardCardProperty } : entry)),
                })
              }
            >
              {taskBoardCardProperties.map((property) => (
                <option key={property} value={property}>
                  {translate(cardPropertyLabels[property], props.language)}
                </option>
              ))}
            </select>
            <select
              aria-label={zh ? '筛选条件' : 'Filter operator'}
              value={condition.operator}
              onChange={(event) =>
                props.onChange({
                  ...props.group,
                  conditions: props.group.conditions.map((entry, entryIndex) => (entryIndex === index && entry.kind === 'rule' ? { ...entry, operator: event.currentTarget.value as TaskBoardFilterOperator } : entry)),
                })
              }
            >
              {filterOperators.map((operator) => (
                <option key={operator.value} value={operator.value}>
                  {translate(operator.label, props.language)}
                </option>
              ))}
            </select>
            {!condition.operator.startsWith('is_') ? (
              <input
                aria-label={zh ? '筛选值' : 'Filter value'}
                value={typeof condition.value === 'string' ? condition.value : ''}
                onChange={(event) =>
                  props.onChange({
                    ...props.group,
                    conditions: props.group.conditions.map((entry, entryIndex) => (entryIndex === index && entry.kind === 'rule' ? { ...entry, value: event.currentTarget.value } : entry)),
                  })
                }
              />
            ) : null}
            <button type="button" aria-label={zh ? '移除筛选条件' : 'Remove filter'} onClick={() => props.onChange({ ...props.group, conditions: props.group.conditions.filter((_, entryIndex) => entryIndex !== index) })}>
              ×
            </button>
          </div>
        ),
      )}
    </div>
  );
}

function TaskBoardSettingsDialog(props: {
  language: TaskBoardViewProps['language'];
  settings: TaskBoardViewSettings;
  groupOptions: ReturnType<typeof taskBoardGroupOptions>;
  subgroupOptions: ReturnType<typeof taskBoardGroupOptions>;
  saving: boolean;
  onDismiss: () => void;
  onSave: (settings: TaskBoardViewSettings) => void;
}) {
  const zh = props.language === 'zh-CN';
  const [draft, setDraft] = useState(props.settings);
  return (
    <ModalPortal onDismiss={props.onDismiss} dismissDisabled={props.saving} rootClassName="task-board-settings-portal">
      <section className="task-board-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="task-board-settings-title">
        <header>
          <div>
            <strong id="task-board-settings-title">{zh ? '看板设置' : 'Board settings'}</strong>
            <small>{zh ? '设置只影响当前项目的看板。' : 'Settings apply to this project board.'}</small>
          </div>
          <button type="button" aria-label={zh ? '关闭看板设置' : 'Close board settings'} disabled={props.saving} onClick={props.onDismiss}>
            ×
          </button>
        </header>
        <div className="task-board-settings-content">
          <fieldset>
            <legend>{zh ? '布局' : 'Layout'}</legend>
            <label>
              <span>{zh ? '主分组' : 'Group by'}</span>
              <select
                value={draft.groupBy}
                onChange={(event) => {
                  const groupBy = event.currentTarget.value as TaskBoardGroupProperty;
                  setDraft((current) => ({ ...current, groupBy, subgroupBy: current.subgroupBy === groupBy ? null : current.subgroupBy, groupOrder: [] }));
                }}
              >
                {taskBoardGroupProperties.map((property) => (
                  <option key={property} value={property}>
                    {translate(groupPropertyLabels[property], props.language)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{zh ? '子分组' : 'Sub-group'}</span>
              <select
                value={draft.subgroupBy ?? ''}
                onChange={(event) => {
                  const subgroupBy = event.currentTarget.value ? (event.currentTarget.value as TaskBoardGroupProperty) : null;
                  setDraft((current) => ({ ...current, subgroupBy }));
                }}
              >
                <option value="">{zh ? '无' : 'None'}</option>
                {taskBoardGroupProperties
                  .filter((property) => property !== draft.groupBy)
                  .map((property) => (
                    <option key={property} value={property}>
                      {translate(groupPropertyLabels[property], props.language)}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>{zh ? '分组排序' : 'Group sort'}</span>
              <select
                value={draft.groupSort}
                onChange={(event) => {
                  const groupSort = event.currentTarget.value as TaskBoardViewSettings['groupSort'];
                  setDraft((current) => ({ ...current, groupSort }));
                }}
              >
                <option value="manual">{zh ? '手工' : 'Manual'}</option>
                <option value="ascending">{zh ? '升序' : 'Ascending'}</option>
                <option value="descending">{zh ? '降序' : 'Descending'}</option>
              </select>
            </label>
            <label className="task-board-setting-check">
              <input
                type="checkbox"
                checked={draft.hideEmptyGroups}
                onChange={(event) => {
                  const hideEmptyGroups = event.currentTarget.checked;
                  setDraft((current) => ({ ...current, hideEmptyGroups }));
                }}
              />
              {zh ? '隐藏空分组' : 'Hide empty groups'}
            </label>
            <label className="task-board-setting-check">
              <input
                type="checkbox"
                checked={draft.colorColumns}
                onChange={(event) => {
                  const colorColumns = event.currentTarget.checked;
                  setDraft((current) => ({ ...current, colorColumns }));
                }}
              />
              {zh ? '使用分组颜色' : 'Color columns'}
            </label>
            {draft.colorColumns ? (
              <div className="task-board-column-color-settings">
                {props.groupOptions.map((option) => (
                  <label key={option.id}>
                    <span>{option.label}</span>
                    <select
                      aria-label={`${zh ? '列颜色' : 'Column color'} ${option.label}`}
                      value={draft.columnColors[option.id] ?? ''}
                      onChange={(event) => {
                        const tone = event.currentTarget.value;
                        setDraft((current) => {
                          const columnColors = { ...current.columnColors };
                          if (tone) columnColors[option.id] = tone as TaskBoardColorTone;
                          else delete columnColors[option.id];
                          return { ...current, columnColors };
                        });
                      }}
                    >
                      <option value="">{zh ? '自动（项目配置）' : 'Automatic'}</option>
                      <option value="neutral">{zh ? '中性' : 'Neutral'}</option>
                      <option value="blue">{zh ? '蓝色' : 'Blue'}</option>
                      <option value="violet">{zh ? '紫色' : 'Violet'}</option>
                      <option value="green">{zh ? '绿色' : 'Green'}</option>
                      <option value="amber">{zh ? '琥珀' : 'Amber'}</option>
                      <option value="orange">{zh ? '橙色' : 'Orange'}</option>
                      <option value="red">{zh ? '红色' : 'Red'}</option>
                    </select>
                  </label>
                ))}
              </div>
            ) : null}
          </fieldset>
          <fieldset>
            <legend>{zh ? '卡片' : 'Cards'}</legend>
            <label>
              <span>{zh ? '尺寸' : 'Size'}</span>
              <select
                value={draft.cardSize}
                onChange={(event) => {
                  const cardSize = event.currentTarget.value as TaskBoardViewSettings['cardSize'];
                  setDraft((current) => ({ ...current, cardSize }));
                }}
              >
                <option value="small">{zh ? '小' : 'Small'}</option>
                <option value="medium">{zh ? '中' : 'Medium'}</option>
                <option value="large">{zh ? '大' : 'Large'}</option>
              </select>
            </label>
            <label>
              <span>{zh ? '预览' : 'Preview'}</span>
              <select
                value={draft.preview}
                onChange={(event) => {
                  const preview = event.currentTarget.value as TaskBoardViewSettings['preview'];
                  setDraft((current) => ({ ...current, preview }));
                }}
              >
                <option value="none">{zh ? '无' : 'None'}</option>
                <option value="content">{zh ? '任务内容' : 'Task content'}</option>
                <option value="first_image">{zh ? '首张真实图片附件' : 'First image attachment'}</option>
              </select>
            </label>
            <label className="task-board-setting-check">
              <input
                type="checkbox"
                checked={draft.fitPreview}
                onChange={(event) => {
                  const fitPreview = event.currentTarget.checked;
                  setDraft((current) => ({ ...current, fitPreview }));
                }}
              />
              {zh ? '填充图片区域' : 'Fit image'}
            </label>
            <label>
              <span>{zh ? '打开方式' : 'Open in'}</span>
              <select
                value={draft.openMode}
                onChange={(event) => {
                  const openMode = event.currentTarget.value as TaskBoardOpenMode;
                  setDraft((current) => ({ ...current, openMode }));
                }}
              >
                <option value="side_peek">{zh ? '右侧抽屉' : 'Side peek'}</option>
                <option value="center_peek">{zh ? '居中预览' : 'Center peek'}</option>
                <option value="full_page">{zh ? '工作区全页' : 'Full page'}</option>
              </select>
            </label>
            <div className="task-board-property-visibility">
              {draft.propertyOrder.map((property, index) => (
                <div key={property}>
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.visibleProperties.includes(property)}
                      onChange={(event) => {
                        const visible = event.currentTarget.checked;
                        setDraft((current) => ({ ...current, visibleProperties: visible ? [...current.visibleProperties, property] : current.visibleProperties.filter((item) => item !== property) }));
                      }}
                    />
                    {translate(cardPropertyLabels[property], props.language)}
                  </label>
                  <button
                    type="button"
                    aria-label={zh ? '向上移动字段' : 'Move property up'}
                    disabled={index === 0}
                    onClick={() =>
                      setDraft((current) => {
                        const order = [...current.propertyOrder];
                        [order[index - 1], order[index]] = [order[index]!, order[index - 1]!];
                        return { ...current, propertyOrder: order };
                      })
                    }
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={zh ? '向下移动字段' : 'Move property down'}
                    disabled={index === draft.propertyOrder.length - 1}
                    onClick={() =>
                      setDraft((current) => {
                        const order = [...current.propertyOrder];
                        [order[index], order[index + 1]] = [order[index + 1]!, order[index]!];
                        return { ...current, propertyOrder: order };
                      })
                    }
                  >
                    ↓
                  </button>
                </div>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>{zh ? '筛选' : 'Filters'}</legend>
            {draft.filters ? (
              <TaskBoardFilterEditor group={draft.filters} depth={1} language={props.language} onChange={(filters) => setDraft((current) => ({ ...current, filters }))} />
            ) : (
              <Button variant="secondary" size="compact" onClick={() => setDraft((current) => ({ ...current, filters: newFilterGroup() }))}>
                {zh ? '添加高级筛选' : 'Add advanced filter'}
              </Button>
            )}
            {draft.filters ? (
              <Button variant="secondary" size="compact" onClick={() => setDraft((current) => ({ ...current, filters: null }))}>
                {zh ? '清除筛选' : 'Clear filters'}
              </Button>
            ) : null}
          </fieldset>
          <fieldset>
            <legend>{zh ? '排序' : 'Sorts'}</legend>
            {draft.sorts.map((sort, index) => (
              <div className="task-board-sort-rule" key={sort.id}>
                <select
                  value={sort.property}
                  onChange={(event) => {
                    const property = event.currentTarget.value as TaskBoardCardProperty;
                    setDraft((current) => ({ ...current, sorts: current.sorts.map((entry, entryIndex) => (entryIndex === index ? { ...entry, property } : entry)) }));
                  }}
                >
                  {taskBoardCardProperties.map((property) => (
                    <option key={property} value={property}>
                      {translate(cardPropertyLabels[property], props.language)}
                    </option>
                  ))}
                </select>
                <select
                  value={sort.direction}
                  onChange={(event) => {
                    const direction = event.currentTarget.value as 'ascending' | 'descending';
                    setDraft((current) => ({ ...current, sorts: current.sorts.map((entry, entryIndex) => (entryIndex === index ? { ...entry, direction } : entry)) }));
                  }}
                >
                  <option value="ascending">{zh ? '升序' : 'Ascending'}</option>
                  <option value="descending">{zh ? '降序' : 'Descending'}</option>
                </select>
                <button type="button" onClick={() => setDraft((current) => ({ ...current, sorts: current.sorts.filter((_, entryIndex) => entryIndex !== index) }))}>
                  ×
                </button>
              </div>
            ))}
            <Button variant="secondary" size="compact" onClick={() => setDraft((current) => ({ ...current, sorts: [...current.sorts, { id: crypto.randomUUID(), property: 'updatedAt', direction: 'descending' }] }))}>
              {zh ? '添加排序' : 'Add sort'}
            </Button>
          </fieldset>
          <fieldset>
            <legend>{zh ? '统计与颜色' : 'Calculation and colors'}</legend>
            <label>
              <span>{zh ? '列底统计' : 'Calculation'}</span>
              <select
                value={draft.calculation.kind}
                onChange={(event) => {
                  const kind = event.currentTarget.value as TaskBoardViewSettings['calculation']['kind'];
                  setDraft((current) => ({ ...current, calculation: kind === 'count_all' ? { kind } : { kind, property: current.calculation.property ?? 'updatedAt' } }));
                }}
              >
                <option value="count_all">{zh ? '任务数量' : 'Count all'}</option>
                <option value="count_values">{zh ? '值数量' : 'Count values'}</option>
                <option value="count_unique">{zh ? '唯一值' : 'Unique values'}</option>
                <option value="count_empty">{zh ? '空值' : 'Empty'}</option>
                <option value="count_not_empty">{zh ? '非空值' : 'Not empty'}</option>
                <option value="percent_empty">{zh ? '空值比例' : 'Percent empty'}</option>
                <option value="percent_not_empty">{zh ? '非空比例' : 'Percent not empty'}</option>
                <option value="earliest_date">{zh ? '最早日期' : 'Earliest date'}</option>
                <option value="latest_date">{zh ? '最晚日期' : 'Latest date'}</option>
                <option value="date_range">{zh ? '日期范围' : 'Date range'}</option>
              </select>
            </label>
            {draft.calculation.kind !== 'count_all' ? (
              <label>
                <span>{zh ? '统计字段' : 'Property'}</span>
                <select
                  value={draft.calculation.property ?? 'updatedAt'}
                  onChange={(event) => {
                    const property = event.currentTarget.value as TaskBoardCardProperty;
                    setDraft((current) => ({ ...current, calculation: { ...current.calculation, property } }));
                  }}
                >
                  {taskBoardCardProperties.map((property) => (
                    <option key={property} value={property}>
                      {translate(cardPropertyLabels[property], props.language)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Button
              variant="secondary"
              size="compact"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  conditionalColors: [...current.conditionalColors, { id: crypto.randomUUID(), tone: 'blue', filter: { id: crypto.randomUUID(), kind: 'group', conjunction: 'and', conditions: [newFilterRule()] } }],
                }))
              }
            >
              {zh ? '添加条件颜色' : 'Add conditional color'}
            </Button>
            {draft.conditionalColors.map((rule, index) => (
              <div className="task-board-color-rule" key={rule.id}>
                <select
                  value={rule.tone}
                  onChange={(event) => {
                    const tone = event.currentTarget.value as TaskBoardColorTone;
                    setDraft((current) => ({ ...current, conditionalColors: current.conditionalColors.map((entry, entryIndex) => (entryIndex === index ? { ...entry, tone } : entry)) }));
                  }}
                >
                  <option value="neutral">{zh ? '中性' : 'Neutral'}</option>
                  <option value="blue">{zh ? '蓝色' : 'Blue'}</option>
                  <option value="violet">{zh ? '紫色' : 'Violet'}</option>
                  <option value="green">{zh ? '绿色' : 'Green'}</option>
                  <option value="amber">{zh ? '琥珀' : 'Amber'}</option>
                  <option value="orange">{zh ? '橙色' : 'Orange'}</option>
                  <option value="red">{zh ? '红色' : 'Red'}</option>
                </select>
                <TaskBoardFilterEditor
                  group={rule.filter}
                  depth={1}
                  language={props.language}
                  onChange={(filter) => setDraft((current) => ({ ...current, conditionalColors: current.conditionalColors.map((entry, entryIndex) => (entryIndex === index ? { ...entry, filter } : entry)) }))}
                />
                <button type="button" onClick={() => setDraft((current) => ({ ...current, conditionalColors: current.conditionalColors.filter((_, entryIndex) => entryIndex !== index) }))}>
                  {zh ? '移除' : 'Remove'}
                </button>
              </div>
            ))}
          </fieldset>
          {draft.hiddenGroupIds.length > 0 ? (
            <fieldset>
              <legend>{zh ? '隐藏分组' : 'Hidden groups'}</legend>
              {props.groupOptions
                .filter((option) => draft.hiddenGroupIds.includes(option.id))
                .map((option) => (
                  <label className="task-board-setting-check" key={option.id}>
                    <input type="checkbox" checked={!draft.hiddenGroupIds.includes(option.id)} onChange={() => setDraft((current) => ({ ...current, hiddenGroupIds: current.hiddenGroupIds.filter((id) => id !== option.id) }))} />
                    {option.label}
                  </label>
                ))}
            </fieldset>
          ) : null}
          {Object.values(draft.hiddenSubgroupIdsByGroup).some((ids) => ids.length > 0) ? (
            <fieldset>
              <legend>{zh ? '隐藏子分组' : 'Hidden subgroups'}</legend>
              {Object.entries(draft.hiddenSubgroupIdsByGroup).flatMap(([groupId, ids]) =>
                ids.map((subgroupId) => {
                  const groupLabel = props.groupOptions.find((option) => option.id === groupId)?.label ?? groupId;
                  const subgroupLabel = props.subgroupOptions.find((option) => option.id === subgroupId)?.label ?? subgroupId;
                  return (
                    <label className="task-board-setting-check" key={`${groupId}\u0000${subgroupId}`}>
                      <input
                        type="checkbox"
                        checked={false}
                        onChange={() =>
                          setDraft((current) => ({
                            ...current,
                            hiddenSubgroupIdsByGroup: {
                              ...current.hiddenSubgroupIdsByGroup,
                              [groupId]: (current.hiddenSubgroupIdsByGroup[groupId] ?? []).filter((id) => id !== subgroupId),
                            },
                          }))
                        }
                      />
                      {groupLabel} / {subgroupLabel}
                    </label>
                  );
                }),
              )}
            </fieldset>
          ) : null}
        </div>
        <footer>
          <Button variant="secondary" size="regular" disabled={props.saving} onClick={props.onDismiss}>
            {zh ? '取消' : 'Cancel'}
          </Button>
          <Button variant="primary" size="regular" busy={props.saving} onClick={() => props.onSave(draft)}>
            {zh ? '保存' : 'Save'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

function optimisticTaskForMove(task: TaskRecord, property: TaskBoardGroupProperty, sourceId: string, targetId: string): TaskRecord {
  if (sourceId === targetId) return task;
  if (property === 'managementStatus') return { ...task, managementStatus: targetId };
  if (property === 'priority') return { ...task, priority: targetId };
  if (property === 'taskType' && (targetId === 'requirement' || targetId === 'defect' || targetId === 'optimization')) return { ...task, taskType: targetId };
  if (property === 'parentTask') return { ...task, parentTaskId: targetId === taskBoardEmptyGroupId ? null : targetId };
  if (property === 'tags') {
    const tags = (task.tags ?? []).filter((tag) => sourceId === taskBoardEmptyGroupId || tag !== sourceId);
    if (targetId !== taskBoardEmptyGroupId && !tags.includes(targetId)) tags.push(targetId);
    return { ...task, tags };
  }
  return task;
}

export function TaskBoardView(props: TaskBoardViewProps) {
  const liveRegionId = `${useId()}-live`;
  const [localSnapshot, setLocalSnapshot] = useState(props.snapshot);
  const [localTasks, setLocalTasks] = useState(props.tasks);
  const [localSettingsOpen, setLocalSettingsOpen] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [moving, setMoving] = useState(false);
  const [activeCard, setActiveCard] = useState<TaskBoardCardModel | null>(null);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const settingsOpen = props.settingsOpen ?? localSettingsOpen;
  const changeSettingsOpen = (open: boolean) => {
    setLocalSettingsOpen(open);
    props.onSettingsOpenChange?.(open);
  };
  useEffect(() => {
    if (!moving && !savingSettings) {
      setLocalSnapshot(props.snapshot);
      setLocalTasks(props.tasks);
    }
  }, [moving, props.snapshot, props.tasks, savingSettings]);

  const snapshot = localSnapshot ?? props.snapshot;
  const settings = snapshot?.settings;
  const context = useMemo<TaskBoardProjectionContext | null>(
    () =>
      settings
        ? {
            language: props.language,
            tasks: localTasks,
            settings,
            positions: snapshot?.positions ?? [],
            statusDefinitions: props.statusDefinitions,
            runStatuses: props.runStatuses,
            branchStatuses: props.branchStatuses,
          }
        : null,
    [localTasks, props.branchStatuses, props.language, props.runStatuses, props.statusDefinitions, settings, snapshot?.positions],
  );
  const groups = useMemo(() => (context ? buildTaskBoardGroups(context) : []), [context]);
  const groupOptions = useMemo(() => (context ? taskBoardGroupOptions(context, context.settings.groupBy) : []), [context]);
  const subgroupOptions = useMemo(() => (context?.settings.subgroupBy ? taskBoardGroupOptions(context, context.settings.subgroupBy) : []), [context]);
  const laneOptions = useMemo(() => {
    if (!context) return [];
    return groups.flatMap((group) =>
      context.settings.subgroupBy ? group.subgroups.map((subgroup) => ({ value: `${group.id}\u0000${subgroup.id}`, label: `${group.label} / ${subgroup.label}` })) : [{ value: `${group.id}\u0000`, label: group.label }],
    );
  }, [context, groups]);
  const screenReaderInstructions = useMemo<ScreenReaderInstructions>(
    () => ({
      draggable:
        props.language === 'zh-CN'
          ? '聚焦拖动柄后，按空格或回车拾取；使用方向键移动；再次按空格或回车放下；按 Escape 取消。也可以使用卡片上的“移动到”菜单。'
          : 'Focus the drag handle, press Space or Enter to pick up, use the arrow keys to move, press Space or Enter again to drop, or press Escape to cancel. You can also use the Move to menu.',
    }),
    [props.language],
  );
  const dragAnnouncements = useMemo<Announcements>(() => {
    const describeDragItem = (data: DragData | undefined): string => {
      if (data?.kind === 'card') return props.language === 'zh-CN' ? `任务“${data.card.task.title}”` : `task “${data.card.task.title}”`;
      if (data?.kind === 'group') {
        const label = groups.find((group) => group.id === data.groupId)?.label ?? data.groupId;
        return props.language === 'zh-CN' ? `分组“${label}”` : `group “${label}”`;
      }
      return props.language === 'zh-CN' ? '看板项目' : 'board item';
    };
    const describeDropTarget = (data: DragData | undefined): string => {
      if (data?.kind === 'card') {
        const group = groups.find((candidate) => candidate.id === data.card.groupId);
        const subgroup = group?.subgroups.find((candidate) => candidate.id === data.card.subgroupId);
        const lane = [group?.label ?? data.card.groupId, subgroup?.label].filter(Boolean).join(' / ');
        return props.language === 'zh-CN' ? `${lane}中“${data.card.task.title}”之前` : `before “${data.card.task.title}” in ${lane}`;
      }
      if (data?.kind === 'lane') {
        const group = groups.find((candidate) => candidate.id === data.groupId);
        const subgroup = group?.subgroups.find((candidate) => candidate.id === data.subgroupId);
        return [group?.label ?? data.groupId, subgroup?.label].filter(Boolean).join(' / ');
      }
      if (data?.kind === 'group') return groups.find((group) => group.id === data.groupId)?.label ?? data.groupId;
      return props.language === 'zh-CN' ? '当前看板' : 'the current board';
    };
    return {
      onDragStart: ({ active }) =>
        props.language === 'zh-CN'
          ? `已拾取${describeDragItem(active.data.current as DragData | undefined)}。使用方向键选择位置，空格或回车放下，Escape 取消。`
          : `Picked up ${describeDragItem(active.data.current as DragData | undefined)}. Use the arrow keys to choose a position, press Space or Enter to drop, or Escape to cancel.`,
      onDragOver: ({ active, over }) => {
        const item = describeDragItem(active.data.current as DragData | undefined);
        if (!over) return props.language === 'zh-CN' ? `${item}当前没有可用落点。` : `${item} is not over a valid target.`;
        const target = describeDropTarget(over.data.current as DragData | undefined);
        return props.language === 'zh-CN' ? `${item}已移动到${target}。` : `${item} moved to ${target}.`;
      },
      onDragEnd: ({ active, over }) => {
        const item = describeDragItem(active.data.current as DragData | undefined);
        if (!over) return props.language === 'zh-CN' ? `${item}移动已取消。` : `${item} move cancelled.`;
        const target = describeDropTarget(over.data.current as DragData | undefined);
        return props.language === 'zh-CN' ? `${item}已放到${target}。` : `${item} dropped at ${target}.`;
      },
      onDragCancel: ({ active }) => {
        const item = describeDragItem(active.data.current as DragData | undefined);
        return props.language === 'zh-CN' ? `${item}移动已取消。` : `${item} move cancelled.`;
      },
    };
  }, [groups, props.language]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (props.loading && !snapshot)
    return (
      <section className="task-board-state" role="status" aria-live="polite">
        {props.language === 'zh-CN' ? '正在载入看板…' : 'Loading board…'}
      </section>
    );
  if (props.error && !snapshot)
    return (
      <section className="task-board-state is-error" role="alert">
        <VisibleApplicationError error={props.error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
        <Button variant="secondary" size="compact" onClick={props.onReload}>
          {props.language === 'zh-CN' ? '重新读取' : 'Reload'}
        </Button>
      </section>
    );
  if (!snapshot || !settings || !context) return null;

  const saveSettings = async (patch: Partial<TaskBoardViewSettings>) => {
    setSavingSettings(true);
    try {
      const updated = await props.onUpdateSettings(patch);
      setLocalSnapshot(updated);
      setAnnouncement(props.language === 'zh-CN' ? '看板设置已保存。' : 'Board settings saved.');
      return updated;
    } catch (error) {
      setAnnouncement(formatVisibleApplicationError(error, props.language === 'zh-CN' ? 'zh-CN' : 'en'));
      props.onReload();
      throw error;
    } finally {
      setSavingSettings(false);
    }
  };

  const moveCard = async (card: TaskBoardCardModel, targetGroupId: string, targetSubgroupId: string, anchors: { beforeTaskId?: string; afterTaskId?: string } = {}) => {
    if (moving) return;
    setMoving(true);
    const previousTasks = localTasks;
    const previousSnapshot = localSnapshot;
    let optimisticTask = optimisticTaskForMove(card.task, settings.groupBy, card.groupId, targetGroupId);
    if (settings.subgroupBy) optimisticTask = optimisticTaskForMove(optimisticTask, settings.subgroupBy, card.subgroupId, targetSubgroupId);
    setLocalTasks((tasks) => tasks.map((task) => (task.id === optimisticTask.id ? optimisticTask : task)));
    setAnnouncement(props.language === 'zh-CN' ? `正在移动“${card.task.title}”。` : `Moving “${card.task.title}”.`);
    try {
      const result = await props.onMoveTask({
        taskId: card.task.id,
        source: { groupId: card.groupId, subgroupId: card.subgroupId },
        target: {
          groupId: targetGroupId,
          subgroupId: targetSubgroupId,
          ...(anchors.beforeTaskId && anchors.beforeTaskId !== card.task.id ? { beforeTaskId: anchors.beforeTaskId } : {}),
          ...(anchors.afterTaskId && anchors.afterTaskId !== card.task.id ? { afterTaskId: anchors.afterTaskId } : {}),
        },
        expectedTaskUpdatedAt: card.task.updatedAt ?? '',
        expectedViewRevision: snapshot.revision,
      });
      setLocalTasks((tasks) => tasks.map((task) => (task.id === result.task.id ? result.task : task)));
      setLocalSnapshot(result.board);
      const targetLabel = laneOptions.find((option) => option.value === `${targetGroupId}\u0000${targetSubgroupId}`)?.label ?? targetGroupId;
      setAnnouncement(props.language === 'zh-CN' ? `“${card.task.title}”已移动到${targetLabel}。` : `“${card.task.title}” moved to ${targetLabel}.`);
    } catch (error) {
      setLocalTasks(previousTasks);
      setLocalSnapshot(previousSnapshot);
      setAnnouncement(formatVisibleApplicationError(error, props.language === 'zh-CN' ? 'zh-CN' : 'en'));
      throw error;
    } finally {
      setMoving(false);
      setActiveCard(null);
    }
  };

  const moveToLane = (card: TaskBoardCardModel, laneValue: string) => {
    const [groupId = '', subgroupId = ''] = laneValue.split('\u0000');
    if (!groupId) return;
    void moveCard(card, groupId, subgroupId).catch(() => undefined);
  };

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as DragData | undefined;
    if (data?.kind === 'card') {
      setActiveCard(data.card);
      setActiveGroupId(null);
      setAnnouncement(
        props.language === 'zh-CN' ? `已拾取“${data.card.task.title}”，使用方向键选择位置，空格确认，Escape 取消。` : `Picked up “${data.card.task.title}”. Use arrow keys to choose a position, Space to drop, Escape to cancel.`,
      );
    } else if (data?.kind === 'group') {
      setActiveGroupId(data.groupId);
      setActiveCard(null);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const active = event.active.data.current as DragData | undefined;
    const over = event.over?.data.current as DragData | undefined;
    setActiveCard(null);
    setActiveGroupId(null);
    if (!active || !over) {
      setAnnouncement(props.language === 'zh-CN' ? '拖动已取消。' : 'Drag cancelled.');
      return;
    }
    if (active.kind === 'group' && over.kind === 'group' && active.groupId !== over.groupId) {
      const currentOrder = reorderVisibleGroupIds(
        settings,
        groupOptions.map((option) => option.id),
        groups.map((group) => group.id),
        active.groupId,
        over.groupId,
      );
      void saveSettings({ groupOrder: currentOrder }).catch(() => undefined);
      return;
    }
    if (active.kind !== 'card') return;
    if (over.kind === 'card' && over.card.occurrenceId === active.card.occurrenceId) {
      setAnnouncement(props.language === 'zh-CN' ? '任务位置未改变。' : 'Task position unchanged.');
      return;
    }
    const targetGroupId = over.kind === 'card' ? over.card.groupId : over.kind === 'lane' ? over.groupId : active.card.groupId;
    const targetSubgroupId = over.kind === 'card' ? over.card.subgroupId : over.kind === 'lane' ? over.subgroupId : active.card.subgroupId;
    let anchors: { beforeTaskId?: string; afterTaskId?: string } = {};
    if (over.kind === 'card') {
      const sourceGroup = groups.find((group) => group.id === active.card.groupId);
      const sourceCards = settings.subgroupBy ? sourceGroup?.subgroups.find((subgroup) => subgroup.id === active.card.subgroupId)?.cards : sourceGroup?.cards;
      const activeIndex = sourceCards?.findIndex((card) => card.occurrenceId === active.card.occurrenceId) ?? -1;
      const overIndex = sourceCards?.findIndex((card) => card.occurrenceId === over.card.occurrenceId) ?? -1;
      anchors = active.card.groupId === over.card.groupId && active.card.subgroupId === over.card.subgroupId && activeIndex >= 0 && overIndex > activeIndex ? { afterTaskId: over.card.task.id } : { beforeTaskId: over.card.task.id };
    }
    void moveCard(active.card, targetGroupId, targetSubgroupId, anchors).catch(() => undefined);
  };

  return (
    <section className="task-board-workbench" data-card-size={settings.cardSize} aria-label={props.language === 'zh-CN' ? '任务看板' : 'Task board'} aria-describedby={liveRegionId}>
      <DndContext
        sensors={sensors}
        accessibility={{ announcements: dragAnnouncements, screenReaderInstructions }}
        collisionDetection={taskBoardCollisionDetection}
        onDragStart={handleDragStart}
        onDragCancel={() => {
          setActiveCard(null);
          setActiveGroupId(null);
          setAnnouncement(props.language === 'zh-CN' ? '拖动已取消。' : 'Drag cancelled.');
        }}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={groups.map((group) => `group:${group.id}`)} strategy={horizontalListSortingStrategy}>
          <div className="task-board-columns">
            {groups.map((group, groupIndex) => (
              <TaskBoardColumn
                key={group.id}
                group={group}
                context={context}
                settings={settings}
                laneOptions={laneOptions}
                busy={moving || savingSettings}
                activeCardOccurrenceId={activeCard?.occurrenceId ?? null}
                groupDropPosition={activeGroupId === group.id ? null : groups.findIndex((entry) => entry.id === activeGroupId) >= 0 && groups.findIndex((entry) => entry.id === activeGroupId) < groupIndex ? 'after' : 'before'}
                onSettingsChange={(patch) => void saveSettings(patch).catch(() => undefined)}
                onMoveToLane={moveToLane}
                onOpenTask={props.onOpenTask}
                loadPreview={props.onLoadAttachmentPreview}
              />
            ))}
            {groups.length === 0 ? <div className="task-board-empty">{props.language === 'zh-CN' ? '当前筛选没有匹配任务。' : 'No tasks match the current filters.'}</div> : null}
          </div>
        </SortableContext>
        <DragOverlay>
          {activeCard ? (
            <div className="task-board-drag-overlay">
              <strong>{activeCard.task.title}</strong>
              <small>{activeCard.task.taskCode ?? activeCard.task.id}</small>
            </div>
          ) : activeGroupId ? (
            <div className="task-board-drag-overlay task-board-group-drag-overlay">
              <strong>{groups.find((group) => group.id === activeGroupId)?.label ?? activeGroupId}</strong>
              <small>{props.language === 'zh-CN' ? '任务分组' : 'Task group'}</small>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <span id={liveRegionId} className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      {settingsOpen ? (
        <TaskBoardSettingsDialog
          language={props.language}
          settings={settings}
          groupOptions={groupOptions}
          subgroupOptions={subgroupOptions}
          saving={savingSettings}
          onDismiss={() => changeSettingsOpen(false)}
          onSave={(draft) => {
            void saveSettings(draft)
              .then(() => changeSettingsOpen(false))
              .catch(() => undefined);
          }}
        />
      ) : null}
    </section>
  );
}
