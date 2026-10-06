import { createHash } from 'node:crypto';
import { defaultTaskManagementStatusLabels, taskManagementStatusDefinitionsEquivalent, taskManagementStatusOrder, type TaskBoardFilterGroup, type TaskBoardViewSettings, type TaskManagementStatusConfig } from '@zeus/shared';
import { migrateTaskBoardStatusPositions, SettingRepository, type ZeusDatabasePort } from '@zeus/storage';
import type { AppShellSettingsSnapshot } from './localServerSettingsNormalization.js';

/** 原始项目配置及冻结来源保持不变，准确别名只用于解释已统一的状态。 */
export interface ArchivedProjectTaskStatuses {
  /** 项目退役前的完整状态定义。 */
  configurations?: Record<string, TaskManagementStatusConfig>;
  /** 首次统一时的准确身份替换，保留原文供历史溯源。 */
  replacements?: Record<string, Record<string, string>>;
  /** 修复错误生成的内置状态副本后，旧全局标识对应的规范标识。 */
  canonicalReplacements?: Record<string, string>;
  /** 退役前的自动化作者修订。 */
  automationRevisionIds?: string[];
  /** 退役前的团队运行。 */
  digitalTeamRunIds?: string[];
  /** 每个项目退役前的事件序号。 */
  taskEventSequenceByProject?: Record<string, number>;
}

/** 只接受归档、原生成算法和未被改名改色的当前定义共同证明的副本。 */
export function generatedTaskManagementStatusReplacements(config: TaskManagementStatusConfig, archive: ArchivedProjectTaskStatuses | null | undefined): Record<string, string> {
  /** 返回准确旧标识映射，不通过标签猜测员工或状态身份。 */
  const replacements: Record<string, string> = {};
  for (const [projectId, original] of Object.entries(archive?.configurations ?? {})) {
    for (const status of original.statuses ?? []) {
      if (!taskManagementStatusOrder.includes(status.id as (typeof taskManagementStatusOrder)[number]) || Object.values(original.roles ?? {}).includes(status.id)) continue;
      /** 还原原迁移生成标识，拒绝任意同名自定义状态。 */
      const generatedId = `legacy_${createHash('sha256').update(`${projectId}\0${status.id}`).digest('hex').slice(0, 32)}`;
      if (archive?.replacements?.[projectId]?.[status.id] !== generatedId) continue;
      /** 规范定义与迁移副本都必须仍保持原语义；后续用户修改不自动合并。 */
      const canonical = config.statuses.find((candidate) => candidate.id === status.id);
      /** 当前可编辑副本的定义。 */
      const generated = config.statuses.find((candidate) => candidate.id === generatedId);
      if (!canonical || !generated || !taskManagementStatusDefinitionsEquivalent(status, canonical)) continue;
      if (generated.label !== (status.label ?? status.id) || generated.color !== status.color) continue;
      /** 内置默认文案才可收回；用户自定义改名即使恰巧与另一状态同名也保留。 */
      if (status.label !== null && status.label !== defaultTaskManagementStatusLabels['zh-CN'][status.id] && status.label !== defaultTaskManagementStatusLabels['en-US'][status.id]) continue;
      replacements[generatedId] = status.id;
    }
  }
  return replacements;
}

/** 历史来源先按原项目解析，再将已证明的迁移副本解释为统一状态。 */
export function resolveArchivedTaskManagementStatus(archive: ArchivedProjectTaskStatuses | null | undefined, projectId: string, statusId: string, source: { revisionId: string } | { eventSequence: number } | { runId: string }): string {
  /** 来源身份与原事件边界不能按时间或同名文本推断。 */
  const legacySource =
    'revisionId' in source
      ? archive?.automationRevisionIds?.includes(source.revisionId)
      : 'eventSequence' in source
        ? archive?.taskEventSequenceByProject?.[projectId] !== undefined && source.eventSequence <= archive.taskEventSequenceByProject[projectId]!
        : archive?.digitalTeamRunIds?.includes(source.runId);
  /** 首次退役后新保存的冻结规则也可能引用副本，准确全局别名对这些来源同样有效。 */
  const projected = legacySource ? (archive?.replacements?.[projectId]?.[statusId] ?? statusId) : statusId;
  return archive?.canonicalReplacements?.[projected] ?? projected;
}

/** 只替换看板筛选中的状态值，标签、正文和其他筛选保持原值。 */
function mapTaskStatusBoardFilter(filter: TaskBoardFilterGroup | null, replacements: Record<string, string>): TaskBoardFilterGroup | null {
  if (!filter) return filter;
  return {
    ...filter,
    conditions: filter.conditions.map((condition) => {
      if (condition.kind === 'group') return mapTaskStatusBoardFilter(condition, replacements)!;
      if (condition.property !== 'managementStatus') return condition;
      return {
        ...condition,
        value: Array.isArray(condition.value) ? condition.value.map((value) => replacements[value] ?? value) : typeof condition.value === 'string' ? (replacements[condition.value] ?? condition.value) : condition.value,
      };
    }),
  };
}

/** 全局看板保留显示偏好，只映射准确的状态泳道、子泳道与条件。 */
function mapTaskStatusBoardSettings(source: TaskBoardViewSettings, replacements: Record<string, string>): TaskBoardViewSettings {
  /** 根据实际分组字段映射，避免误改恰巧同名的标签或任务分组。 */
  const mapGroup = (id: string): string => (source.groupBy === 'managementStatus' ? (replacements[id] ?? id) : id);
  /** 子分组独立按自己的字段映射。 */
  const mapSubgroup = (id: string): string => (source.subgroupBy === 'managementStatus' ? (replacements[id] ?? id) : id);
  /** 重复身份合并后保留原次序。 */
  const mapList = (values: string[], map: (id: string) => string): string[] => [...new Set(values.map(map))];
  /** 合并碰撞的展开或隐藏列表，不丢弃任何已配置子泳道。 */
  const mapSubgroups = (values: Record<string, string[]>): Record<string, string[]> => {
    /** 只构建新的显示对象，不改原设置输入。 */
    const result: Record<string, string[]> = {};
    for (const [group, ids] of Object.entries(values)) result[mapGroup(group)] = [...new Set([...(result[mapGroup(group)] ?? []), ...ids.map(mapSubgroup)])];
    return result;
  };
  return {
    ...source,
    groupOrder: mapList(source.groupOrder, mapGroup),
    hiddenGroupIds: mapList(source.hiddenGroupIds, mapGroup),
    collapsedGroupIds: mapList(source.collapsedGroupIds, mapGroup),
    hiddenSubgroupIdsByGroup: mapSubgroups(source.hiddenSubgroupIdsByGroup),
    collapsedSubgroupIdsByGroup: mapSubgroups(source.collapsedSubgroupIdsByGroup),
    columnColors: Object.fromEntries(Object.entries(source.columnColors).map(([id, color]) => [mapGroup(id), source.columnColors[mapGroup(id)] ?? color])),
    filters: mapTaskStatusBoardFilter(source.filters, replacements),
    conditionalColors: source.conditionalColors.map((rule) => ({ ...rule, filter: mapTaskStatusBoardFilter(rule.filter, replacements)! })),
  };
}

/** 一次事务纠正可编辑引用；冻结规则、运行、事件和原迁移归档均保留原文。 */
export function repairGeneratedTaskManagementStatuses(input: {
  /** 当前宿主的真实存储事务。 */
  db: ZeusDatabasePort;
  /** 生效的全局设置快照。 */
  appShellSettings: AppShellSettingsSnapshot;
  /** 本轮统一的更新时间。 */
  timestamp: string;
  /** 沿用真实事件账本与文件投影，迁移事件禁止触发自动化。 */
  recordMigration: (task: { id: string; project_id: string; management_status: string }, targetStatus: string) => void;
}): AppShellSettingsSnapshot | null {
  /** 归档与显示设置共用产品存储，不新增旁路文件。 */
  const settings = new SettingRepository(input.db);
  /** 准确原配置和来源身份。 */
  const archive = settings.getJson<ArchivedProjectTaskStatuses>('archive.project-task-status-settings');
  /** 没有准确证明的状态一律保留。 */
  const replacements = generatedTaskManagementStatusReplacements(input.appShellSettings.taskManagementStatusTemplate, archive);
  /** 空集合保证重复启动不改写数据库或修订。 */
  const changes = Object.entries(replacements);
  if (!changes.length) return null;
  /** 修复后的全局显示，用户真实自定义状态和默认角色均保留。 */
  const next: AppShellSettingsSnapshot = {
    ...input.appShellSettings,
    taskManagementStatusTemplate: {
      statuses: input.appShellSettings.taskManagementStatusTemplate.statuses.filter((status) => !replacements[status.id]),
      roles: {
        defaultStatusId: replacements[input.appShellSettings.taskManagementStatusTemplate.roles.defaultStatusId] ?? input.appShellSettings.taskManagementStatusTemplate.roles.defaultStatusId,
        pushedStatusId: replacements[input.appShellSettings.taskManagementStatusTemplate.roles.pushedStatusId] ?? input.appShellSettings.taskManagementStatusTemplate.roles.pushedStatusId,
        completedStatusId: replacements[input.appShellSettings.taskManagementStatusTemplate.roles.completedStatusId] ?? input.appShellSettings.taskManagementStatusTemplate.roles.completedStatusId,
        cancelledStatusId: replacements[input.appShellSettings.taskManagementStatusTemplate.roles.cancelledStatusId] ?? input.appShellSettings.taskManagementStatusTemplate.roles.cancelledStatusId,
      },
    },
    taskStatusFilter: replacements[input.appShellSettings.taskStatusFilter] ?? input.appShellSettings.taskStatusFilter,
    taskTableEnumSortOrders: { ...input.appShellSettings.taskTableEnumSortOrders, managementStatus: [...new Set(input.appShellSettings.taskTableEnumSortOrders.managementStatus.map((id) => replacements[id] ?? id))] },
    sidebarConversationFilters: input.appShellSettings.sidebarConversationFilters
      ? {
          ...input.appShellSettings.sidebarConversationFilters,
          conversationStatusFilters: [
            ...new Set(input.appShellSettings.sidebarConversationFilters.conversationStatusFilters.map((filter) => (filter.startsWith('status:') ? `status:${replacements[filter.slice(7)] ?? filter.slice(7)}` : filter))),
          ],
        }
      : undefined,
  };
  input.db.transaction(() => {
    /** 活跃与归档任务同时纠正，已删除任务只作为历史原文保留。 */
    const tasks = input.db.select<{ id: string; project_id: string; management_status: string }>(
      `SELECT id,project_id,management_status FROM tasks WHERE deleted_at IS NULL AND management_status IN (${changes.map(() => '?').join(',')})`,
      changes.map(([id]) => id),
    );
    input.db.execute(
      `UPDATE tasks SET management_status = CASE management_status ${changes.map(() => 'WHEN ? THEN ?').join(' ')} ELSE management_status END WHERE deleted_at IS NULL AND management_status IN (${changes.map(() => '?').join(',')})`,
      [...changes.flat(), ...changes.map(([id]) => id)],
    );
    for (const task of tasks) input.recordMigration(task, replacements[task.management_status]!);
    for (const project of input.db.select<{ project_id: string }>('SELECT DISTINCT project_id FROM task_board_positions')) migrateTaskBoardStatusPositions(input.db, project.project_id, replacements);
    /** 可编辑团队只改三个准确状态字段，工作要求及员工身份不参与此修复。 */
    for (const template of input.db.select<{ id: string; definition_json: string }>('SELECT id,definition_json FROM digital_team_workflow_templates WHERE deleted_at IS NULL')) {
      /** 坏草稿由正常编辑器处理，不猜测或重建其结构。 */
      const definition = JSON.parse(template.definition_json) as { nodes?: Array<{ type?: string; data?: Record<string, unknown> }> } | null;
      if (!definition || !Array.isArray(definition.nodes)) continue;
      /** 只在真实状态引用发生改变时递增团队修订。 */
      let changed = false;
      for (const node of definition.nodes) {
        if (node?.type !== 'employee' || !node.data || typeof node.data !== 'object' || Array.isArray(node.data)) continue;
        for (const key of ['triggerStatusId', 'startStatusId', 'completionStatusId'] as const) {
          /** 来源为状态字段，而不是任意相同文本。 */
          const id = node.data[key];
          if (typeof id === 'string' && replacements[id]) {
            node.data[key] = replacements[id];
            changed = true;
          }
        }
      }
      if (changed) input.db.execute('UPDATE digital_team_workflow_templates SET definition_json=?,revision=revision+1,updated_at=? WHERE id=?', [JSON.stringify(definition), input.timestamp, template.id]);
    }
    /** 旧项目看板原文继续保留，只更新生效的统一显示设置。 */
    const board = settings.getJson<{ settings: TaskBoardViewSettings; revision: number; updatedAt: string }>('task-board.global-display');
    if (board?.settings) {
      /** 显示变更仍遵守原看板修订保护。 */
      const mapped = mapTaskStatusBoardSettings(board.settings, replacements);
      if (JSON.stringify(mapped) !== JSON.stringify(board.settings)) settings.setJson('task-board.global-display', { ...board, settings: mapped, revision: board.revision + 1, updatedAt: input.timestamp });
    }
    settings.setJson('archive.project-task-status-settings', { ...archive, canonicalReplacements: { ...archive?.canonicalReplacements, ...replacements }, canonicalizedAt: input.timestamp });
    settings.setJson('app.shell.settings', next);
  });
  return next;
}
