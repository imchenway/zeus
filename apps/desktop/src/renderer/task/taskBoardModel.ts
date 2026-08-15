import {
  taskBoardEmptyGroupId,
  taskBoardLayoutKey,
  type TaskBoardCalculation,
  type TaskBoardCardProperty,
  type TaskBoardColorTone,
  type TaskBoardConditionalColorRule,
  type TaskBoardFilterGroup,
  type TaskBoardFilterRule,
  type TaskBoardGroupProperty,
  type TaskBoardPosition,
  type TaskBoardSortRule,
  type TaskBoardViewSettings,
  type TaskManagementStatusDefinition,
} from '@zeus/shared';
import type { TaskAgentRunStatus, TaskRecord } from '../apiClient.js';
import { formatTaskType, type TaskBranchStatus } from './taskWorkspaceModel.js';

export interface TaskBoardProjectionContext {
  language: 'zh-CN' | 'en-US';
  tasks: TaskRecord[];
  settings: TaskBoardViewSettings;
  positions: TaskBoardPosition[];
  statusDefinitions: readonly TaskManagementStatusDefinition[];
  runStatuses: Record<string, TaskAgentRunStatus | undefined>;
  branchStatuses: Record<string, TaskBranchStatus | undefined>;
}

export interface TaskBoardGroupOption {
  id: string;
  label: string;
  color?: string;
}

export interface TaskBoardCardModel {
  id: string;
  occurrenceId: string;
  task: TaskRecord;
  groupId: string;
  subgroupId: string;
  tone: TaskBoardColorTone;
}

export interface TaskBoardSubgroupModel {
  id: string;
  label: string;
  cards: TaskBoardCardModel[];
  taskCount: number;
  calculation: string;
}

export interface TaskBoardGroupModel {
  id: string;
  label: string;
  color?: string;
  cards: TaskBoardCardModel[];
  subgroups: TaskBoardSubgroupModel[];
  taskCount: number;
  calculation: string;
}

const priorityOptions: TaskBoardGroupOption[] = ['p0', 'p1', 'p2', 'p3', 'p4'].map((id) => ({ id, label: id.toUpperCase() }));
const runStatusIds: TaskAgentRunStatus[] = ['not_started', 'connecting', 'reconnecting', 'running', 'waiting_user', 'waiting_approval', 'paused', 'idle', 'failed', 'legacy_readonly'];
const branchStatusIds: TaskBranchStatus[] = ['action_required', 'active', 'pushed', 'merged', 'discarded', 'not_created'];
const defaultManagementStatusLabels: Record<'zh-CN' | 'en-US', Record<string, string>> = {
  'zh-CN': { todo: '待开始', in_development: '开发中', in_testing: '测试中', awaiting_acceptance: '待验收', blocked: '已阻塞', completed: '已完成', cancelled: '已取消' },
  'en-US': { todo: 'To do', in_development: 'In development', in_testing: 'In testing', awaiting_acceptance: 'Awaiting acceptance', blocked: 'Blocked', completed: 'Completed', cancelled: 'Cancelled' },
};

function uniqueOptions(options: TaskBoardGroupOption[]): TaskBoardGroupOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.id)) return false;
    seen.add(option.id);
    return true;
  });
}

export function taskBoardGroupOptions(context: TaskBoardProjectionContext, property: TaskBoardGroupProperty): TaskBoardGroupOption[] {
  const zh = context.language === 'zh-CN';
  if (property === 'managementStatus') return context.statusDefinitions.map((status) => ({ id: status.id, label: status.label?.trim() || defaultManagementStatusLabels[context.language][status.id] || status.id, color: status.color }));
  if (property === 'priority') return priorityOptions;
  if (property === 'taskType') return (['requirement', 'defect', 'optimization'] as const).map((taskType) => ({ id: taskType, label: formatTaskType(taskType, context.language) }));
  if (property === 'tags')
    return [
      { id: taskBoardEmptyGroupId, label: zh ? '无标签' : 'No tags' },
      ...Array.from(new Set(context.tasks.flatMap((task) => task.tags ?? [])))
        .sort((left, right) => left.localeCompare(right, context.language))
        .map((tag) => ({ id: tag, label: tag })),
    ];
  if (property === 'parentTask') return [{ id: taskBoardEmptyGroupId, label: zh ? '无父任务' : 'No parent task' }, ...context.tasks.map((task) => ({ id: task.id, label: `${task.taskCode ?? task.id} · ${task.title}` }))];
  if (property === 'runStatus')
    return runStatusIds.map((id) => ({
      id,
      label: (
        {
          not_started: zh ? '未开始' : 'Not started',
          connecting: zh ? '连接中' : 'Connecting',
          reconnecting: zh ? '重连中' : 'Reconnecting',
          running: zh ? '运行中' : 'Running',
          waiting_user: zh ? '等待回复' : 'Waiting for reply',
          waiting_approval: zh ? '等待授权' : 'Waiting for approval',
          paused: zh ? '已暂停' : 'Paused',
          idle: zh ? '空闲' : 'Idle',
          failed: zh ? '失败' : 'Failed',
          legacy_readonly: zh ? '只读' : 'Read only',
        } as const
      )[id],
    }));
  if (property === 'branchStatus')
    return branchStatusIds.map((id) => ({
      id,
      label: (
        {
          action_required: zh ? 'Git 待处理' : 'Git action needed',
          active: zh ? '开发中' : 'In development',
          pushed: zh ? '已推送，待合入' : 'Pushed',
          merged: zh ? '已合入' : 'Merged',
          discarded: zh ? '已放弃' : 'Discarded',
          not_created: zh ? '未创建' : 'Not created',
        } as const
      )[id],
    }));
  return uniqueOptions([
    { id: taskBoardEmptyGroupId, label: zh ? '未知来源' : 'Unknown source' },
    ...context.tasks.map((task) => ({ id: task.createdFrom || taskBoardEmptyGroupId, label: task.createdFrom || (zh ? '未知来源' : 'Unknown source') })),
  ]);
}

export function taskBoardGroupValues(task: TaskRecord, property: TaskBoardGroupProperty, context: TaskBoardProjectionContext): string[] {
  if (property === 'managementStatus') return [task.managementStatus ?? 'todo'];
  if (property === 'priority') return [task.priority ?? taskBoardEmptyGroupId];
  if (property === 'taskType') return [task.taskType];
  if (property === 'tags') return task.tags && task.tags.length > 0 ? task.tags : [taskBoardEmptyGroupId];
  if (property === 'parentTask') return [task.parentTaskId ?? taskBoardEmptyGroupId];
  if (property === 'runStatus') return [context.runStatuses[task.id] ?? 'not_started'];
  if (property === 'branchStatus') return [context.branchStatuses[task.id] ?? 'not_created'];
  return [task.createdFrom || taskBoardEmptyGroupId];
}

export function taskBoardCardPropertyValues(task: TaskRecord, property: TaskBoardCardProperty, context: TaskBoardProjectionContext): string[] {
  if (property === 'code') return [task.taskCode ?? task.id];
  if (property === 'managementStatus') return taskBoardGroupValues(task, 'managementStatus', context);
  if (property === 'priority') return taskBoardGroupValues(task, 'priority', context);
  if (property === 'taskType') return taskBoardGroupValues(task, 'taskType', context);
  if (property === 'runStatus') return taskBoardGroupValues(task, 'runStatus', context);
  if (property === 'branchStatus') return taskBoardGroupValues(task, 'branchStatus', context);
  if (property === 'tags') return taskBoardGroupValues(task, 'tags', context);
  if (property === 'parentTask') return taskBoardGroupValues(task, 'parentTask', context);
  if (property === 'source') return taskBoardGroupValues(task, 'source', context);
  if (property === 'createdAt') return [task.createdAt ?? ''];
  return [task.updatedAt ?? ''];
}

function filterRuleMatches(task: TaskRecord, rule: TaskBoardFilterRule, context: TaskBoardProjectionContext): boolean {
  const values = taskBoardCardPropertyValues(task, rule.property, context).map((value) => value.toLocaleLowerCase());
  const wanted = (Array.isArray(rule.value) ? rule.value : [rule.value ?? '']).map((value) => value.toLocaleLowerCase());
  if (rule.operator === 'is_empty') return values.length === 0 || values.every((value) => !value || value === taskBoardEmptyGroupId);
  if (rule.operator === 'is_not_empty') return values.some((value) => Boolean(value) && value !== taskBoardEmptyGroupId);
  if (rule.operator === 'equals') return wanted.some((value) => values.includes(value));
  if (rule.operator === 'not_equals') return wanted.every((value) => !values.includes(value));
  if (rule.operator === 'contains') return wanted.some((value) => values.some((candidate) => candidate.includes(value)));
  return wanted.every((value) => values.every((candidate) => !candidate.includes(value)));
}

export function taskBoardFilterMatches(task: TaskRecord, filter: TaskBoardFilterGroup | null, context: TaskBoardProjectionContext): boolean {
  if (!filter || filter.conditions.length === 0) return true;
  const matches = filter.conditions.map((condition) => (condition.kind === 'group' ? taskBoardFilterMatches(task, condition, context) : filterRuleMatches(task, condition, context)));
  return filter.conjunction === 'and' ? matches.every(Boolean) : matches.some(Boolean);
}

function compareTaskBoardValues(left: TaskRecord, right: TaskRecord, sort: TaskBoardSortRule, context: TaskBoardProjectionContext): number {
  const leftValue = taskBoardCardPropertyValues(left, sort.property, context).join('\u0000');
  const rightValue = taskBoardCardPropertyValues(right, sort.property, context).join('\u0000');
  const comparison = leftValue.localeCompare(rightValue, context.language, { numeric: true, sensitivity: 'base' });
  return sort.direction === 'ascending' ? comparison : -comparison;
}

function cardTone(task: TaskRecord, rules: TaskBoardConditionalColorRule[], context: TaskBoardProjectionContext): TaskBoardColorTone {
  return rules.find((rule) => taskBoardFilterMatches(task, rule.filter, context))?.tone ?? 'neutral';
}

function calculateLane(tasks: TaskRecord[], calculation: TaskBoardCalculation, context: TaskBoardProjectionContext): string {
  const zh = context.language === 'zh-CN';
  if (calculation.kind === 'count_all' || !calculation.property) return zh ? `${tasks.length} 项` : `${tasks.length} items`;
  const values = tasks.flatMap((task) => taskBoardCardPropertyValues(task, calculation.property!, context)).filter((value) => value && value !== taskBoardEmptyGroupId);
  if (calculation.kind === 'count_values') return String(values.length);
  if (calculation.kind === 'count_unique') return String(new Set(values).size);
  const emptyCount = tasks.filter((task) => taskBoardCardPropertyValues(task, calculation.property!, context).every((value) => !value || value === taskBoardEmptyGroupId)).length;
  if (calculation.kind === 'count_empty') return String(emptyCount);
  if (calculation.kind === 'count_not_empty') return String(tasks.length - emptyCount);
  if (calculation.kind === 'percent_empty') return tasks.length === 0 ? '0%' : `${Math.round((emptyCount / tasks.length) * 100)}%`;
  if (calculation.kind === 'percent_not_empty') return tasks.length === 0 ? '0%' : `${Math.round(((tasks.length - emptyCount) / tasks.length) * 100)}%`;
  const timestamps = values
    .map(Date.parse)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (timestamps.length === 0) return '—';
  const format = (value: number) => new Intl.DateTimeFormat(context.language, { dateStyle: 'short' }).format(value);
  if (calculation.kind === 'earliest_date') return format(timestamps[0]!);
  if (calculation.kind === 'latest_date') return format(timestamps.at(-1)!);
  return `${format(timestamps[0]!)} – ${format(timestamps.at(-1)!)}`;
}

export function buildTaskBoardGroups(context: TaskBoardProjectionContext): TaskBoardGroupModel[] {
  const layoutKey = taskBoardLayoutKey(context.settings);
  const positionRanks = new Map(context.positions.filter((position) => position.layoutKey === layoutKey).map((position) => [`${position.groupId}\u0000${position.subgroupId}\u0000${position.taskId}`, position.rank]));
  const filteredTasks = context.tasks.filter((task) => taskBoardFilterMatches(task, context.settings.filters, context));
  // 搜索和高级筛选只改变卡片，不应在“显示空分组”时把真实分组选项一起删除。
  const groupOptions = taskBoardGroupOptions(context, context.settings.groupBy);
  const groupOptionMap = new Map(groupOptions.map((option) => [option.id, option]));
  for (const task of filteredTasks) {
    for (const groupId of taskBoardGroupValues(task, context.settings.groupBy, context)) {
      if (!groupOptionMap.has(groupId)) groupOptionMap.set(groupId, { id: groupId, label: groupId });
    }
  }
  const settingsGroupOrder = new Map(context.settings.groupOrder.map((id, index) => [id, index]));
  const groups = [...groupOptionMap.values()]
    .filter((option) => !context.settings.hiddenGroupIds.includes(option.id))
    .sort((left, right) => {
      if (context.settings.groupSort === 'ascending') return left.label.localeCompare(right.label, context.language);
      if (context.settings.groupSort === 'descending') return right.label.localeCompare(left.label, context.language);
      return (
        (settingsGroupOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (settingsGroupOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
        groupOptions.findIndex((option) => option.id === left.id) - groupOptions.findIndex((option) => option.id === right.id)
      );
    });

  return groups.flatMap((group): TaskBoardGroupModel[] => {
    const groupTasks = filteredTasks.filter((task) => taskBoardGroupValues(task, context.settings.groupBy, context).includes(group.id));
    const subgroupOptions = context.settings.subgroupBy ? taskBoardGroupOptions({ ...context, tasks: groupTasks }, context.settings.subgroupBy) : [];
    const subgroupIds = context.settings.subgroupBy
      ? uniqueOptions([...subgroupOptions, ...groupTasks.flatMap((task) => taskBoardGroupValues(task, context.settings.subgroupBy!, context).map((id) => ({ id, label: subgroupOptions.find((option) => option.id === id)?.label ?? id })))])
      : [];
    const buildCards = (tasks: TaskRecord[], subgroupId: string): TaskBoardCardModel[] => {
      const cards = tasks.map((task) => ({
        id: task.id,
        occurrenceId: `${task.id}\u0000${group.id}\u0000${subgroupId}`,
        task,
        groupId: group.id,
        subgroupId,
        tone: cardTone(task, context.settings.conditionalColors, context),
      }));
      cards.sort((left, right) => {
        for (const sort of context.settings.sorts) {
          const comparison = compareTaskBoardValues(left.task, right.task, sort, context);
          if (comparison !== 0) return comparison;
        }
        const leftRank = positionRanks.get(`${group.id}\u0000${subgroupId}\u0000${left.task.id}`);
        const rightRank = positionRanks.get(`${group.id}\u0000${subgroupId}\u0000${right.task.id}`);
        if (leftRank !== undefined || rightRank !== undefined) return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
        return (left.task.taskSequence ?? Number.MAX_SAFE_INTEGER) - (right.task.taskSequence ?? Number.MAX_SAFE_INTEGER) || (left.task.createdAt ?? '').localeCompare(right.task.createdAt ?? '') || left.task.id.localeCompare(right.task.id);
      });
      return cards;
    };
    const cards = context.settings.subgroupBy ? [] : buildCards(groupTasks, '');
    const subgroups = context.settings.subgroupBy
      ? subgroupIds
          .filter((subgroup) => !(context.settings.hiddenSubgroupIdsByGroup[group.id] ?? []).includes(subgroup.id))
          .map((subgroup) => {
            const tasks = groupTasks.filter((task) => taskBoardGroupValues(task, context.settings.subgroupBy!, context).includes(subgroup.id));
            const subgroupCards = buildCards(tasks, subgroup.id);
            return { id: subgroup.id, label: subgroup.label, cards: subgroupCards, taskCount: tasks.length, calculation: calculateLane(tasks, context.settings.calculation, context) };
          })
          .filter((subgroup) => !context.settings.hideEmptyGroups || subgroup.cards.length > 0)
      : [];
    if (context.settings.hideEmptyGroups && cards.length === 0 && subgroups.every((subgroup) => subgroup.cards.length === 0)) return [];
    return [{ ...group, cards, subgroups, taskCount: groupTasks.length, calculation: calculateLane(groupTasks, context.settings.calculation, context) }];
  });
}

export function taskBoardActiveContent(task: TaskRecord): string {
  if (task.taskType === 'defect') return [task.defectCurrentState, task.defectExpectedOutcome, task.defectReproductionSteps].find((value) => value?.trim())?.trim() ?? '';
  if (task.taskType === 'optimization') return [task.optimizationCurrentState, task.optimizationExpectedOutcome].find((value) => value?.trim())?.trim() ?? '';
  return task.description?.trim() ?? '';
}
