import { digitalEmployeeAvatarIds, digitalTeamExecutionDefinition, type DigitalEmployeeAvatarId, type DigitalTeamWorkflowTemplateRecord } from '@zeus/shared';
import type { NativeConversationChoice } from '../../session/sessionTypes.js';
import type { DigitalTeamRunProjection } from '../digital-teams/digitalTeamApiClient.js';
import { digitalTeamRunStatusLabel, getDigitalTeamRunBlocker } from '../digital-teams/digitalTeamRunPresentation.js';
import type { DigitalEmployeeRecord, TaskWorkItemRecord } from './digitalEmployeeContracts.js';

/** 导航只需要冻结身份，不要求历史员工仍在可指派目录中。 */
export interface TaskConversationEmployee {
  /** 原员工身份。 */
  id: string;
  /** 全局来源与项目绑定指向同一员工，不能误判成换人。 */
  globalEmployeeId: string | null;
  /** 当时的显示名称。 */
  name: string;
  /** 岗位用于原头像组件的默认头像。 */
  role: string;
  /** 已验证的预置头像。 */
  avatarId: DigitalEmployeeAvatarId | null;
}

/** 同一真实会话只列一次，重试产生的新会话保留独立入口。 */
export interface TaskConversationEntry {
  /** 原始会话身份，未启动分工为空。 */
  conversationId: string | null;
  /** 分工或会话标题。 */
  title: string;
  /** 原创建时间，不使用轮询到达时间。 */
  createdAt: string;
  /** 后端权威状态。 */
  status: string;
  /** 当前有效工作，历史失败不冒充当前执行。 */
  current: boolean;
  /** 原受阻原因。 */
  reason?: string;
}

/** 员工条目内保留其多份分工和会话。 */
export interface TaskConversationEmployeeGroup {
  /** 冻结员工；普通任务讨论为空。 */
  employee: TaskConversationEmployee | null;
  /** 员工条目的稳定身份。 */
  id: string;
  /** 该员工在所选团队执行中的原会话。 */
  entries: TaskConversationEntry[];
}

/** 一次团队执行与独立任务会话分别导航。 */
export interface TaskConversationExecutionGroup {
  /** 团队执行身份，独立会话使用固定分组。 */
  id: string;
  /** 团队名称。 */
  name: string;
  /** 时间与状态摘要。 */
  description: string;
  /** 真实团队投影，普通会话为空。 */
  team: DigitalTeamRunProjection | null;
  /** 员工及其会话。 */
  employees: TaskConversationEmployeeGroup[];
}

/** 独立会话入口不与服务端运行身份混用。 */
export const independentConversationGroupId = 'task-conversations';

/** 终态团队不会再作为当前执行；未知结果必须保持可见。 */
export function isCurrentTaskTeam(team: DigitalTeamRunProjection): boolean {
  return !['completed', 'failed', 'cancelled'].includes(team.run.status);
}

/** 只从实际配置读取显示身份，目录删除不抹掉历史员工。 */
function employeeIdentity(id: string, snapshot: Record<string, unknown> | undefined, employees: DigitalEmployeeRecord[]): TaskConversationEmployee {
  /** 现有目录仅补齐旧记录缺失的显示字段。 */
  const employee = employees.find((entry) => entry.id === id);
  /** 冻结头像必须属于现有头像目录。 */
  const avatar = snapshot?.avatarId ?? employee?.avatarId;
  return {
    id: typeof snapshot?.id === 'string' ? snapshot.id : id,
    globalEmployeeId: typeof snapshot?.globalEmployeeId === 'string' ? snapshot.globalEmployeeId : (employee?.globalEmployeeId ?? null),
    name: typeof snapshot?.name === 'string' ? snapshot.name : (employee?.name ?? '数字员工'),
    role: typeof snapshot?.role === 'string' ? snapshot.role : (employee?.role ?? ''),
    avatarId: digitalEmployeeAvatarIds.includes(avatar as DigitalEmployeeAvatarId) ? (avatar as DigitalEmployeeAvatarId) : null,
  };
}

/** 用真实团队、节点、工作运行和会话身份组合导航，不按名称或次数猜关联。 */
export function buildTaskConversationNavigation(input: {
  /** 完整历史团队投影。 */
  teams: DigitalTeamRunProjection[];
  /** 当前模板只用于补充团队名称。 */
  templates: DigitalTeamWorkflowTemplateRecord[];
  /** 员工目录。 */
  employees: DigitalEmployeeRecord[];
  /** 原工作投影。 */
  items: TaskWorkItemRecord[];
  /** 普通任务会话。 */
  conversations: NativeConversationChoice[];
  /** 当前界面语言。 */
  language: 'zh-CN' | 'en-US';
}): TaskConversationExecutionGroup[] {
  /** 中文与英文共用身份和排序。 */
  const zh = input.language === 'zh-CN';
  /** 工作运行提供历史节点缺失时的冻结身份。 */
  const works = new Map(input.items.flatMap((item) => item.runs.map((run) => [run.id, { item, run }] as const)));
  /** 已归属团队的工作不重复出现在独立会话中。 */
  const teamWorkIds = new Set<string>();
  /** 会话可由多个节点复用，但不再重复放入普通讨论。 */
  const teamConversationIds = new Set<string>();
  /** 向员工列表加入原会话，复用会话时合并分工标题。 */
  function append(group: TaskConversationExecutionGroup, employee: TaskConversationEmployee | null, entry: TaskConversationEntry): void {
    /** 普通讨论有独立身份，不占用员工身份。 */
    const id = employee?.id ?? 'discussion';
    /** 同一员工的多个节点合并展示。 */
    let member = group.employees.find((candidate) => candidate.id === id);
    if (!member) {
      member = { id, employee, entries: [] };
      group.employees.push(member);
    }
    /** 主会话可能同时承担规划与汇总。 */
    const previous = entry.conversationId ? member.entries.find((candidate) => candidate.conversationId === entry.conversationId) : null;
    if (previous) {
      if (!previous.title.split(' / ').includes(entry.title)) previous.title += ` / ${entry.title}`;
      if (entry.current || entry.createdAt > previous.createdAt) Object.assign(previous, { ...entry, title: previous.title });
    } else member.entries.push(entry);
  }
  /** 列表排序只依据原时间与身份，后台刷新不会改变同值顺序。 */
  const groups = input.teams.map((team): TaskConversationExecutionGroup => {
    /** 本次冻结图加已接纳规划，不能使用后来编辑的模板节点。 */
    const nodes = digitalTeamExecutionDefinition(team.run).nodes;
    /** 团队原因使用现有权威展示函数。 */
    const blocker = getDigitalTeamRunBlocker(team, zh);
    /** 模板删除后仍以日期和原运行身份区分记录。 */
    const group: TaskConversationExecutionGroup = {
      id: team.run.id,
      name: input.templates.find((template) => template.id === team.run.templateId)?.name ?? (zh ? '数字团队' : 'Digital team'),
      description: `${new Date(team.run.createdAt).toLocaleString(input.language, { dateStyle: 'short', timeStyle: 'medium' })} · ${digitalTeamRunStatusLabel(team.run, zh)}`,
      team,
      employees: [],
    };
    for (const attempt of team.nodeAttempts) {
      /** 老规划节点也可以从真实工作运行恢复身份。 */
      const work = attempt.workRunId ? works.get(attempt.workRunId) : undefined;
      /** 当前定义仅补充分工标题。 */
      const node = nodes.find((entry) => entry.id === attempt.nodeId) ?? team.run.definitionSnapshot.nodes.find((entry) => entry.id === attempt.nodeId);
      /** 冻结的角色配置优先于当前员工目录。 */
      const role = node?.type === 'employee' ? team.run.roleSnapshots.find((entry) => entry.employeeId === node.data.employeeId) : undefined;
      /** 非员工流程节点不伪造员工身份。 */
      const employee = role ? employeeIdentity(role.employeeId, role.configuration, input.employees) : work ? employeeIdentity(work.run.employeeId, work.run.employeeSnapshot, input.employees) : null;
      if (attempt.workRunId) teamWorkIds.add(attempt.workRunId);
      if (attempt.conversationId) teamConversationIds.add(attempt.conversationId);
      if (!employee && !attempt.conversationId) continue;
      append(group, employee, {
        conversationId: attempt.conversationId,
        title: work?.item.title ?? node?.data.title ?? (zh ? '团队会话' : 'Team conversation'),
        createdAt: attempt.createdAt,
        status: attempt.status,
        current: isCurrentTaskTeam(team) && team.currentAttempts.some((current) => current.id === attempt.id) && (['prepared', 'dispatching', 'active', 'outcome_unknown'].includes(attempt.status) || blocker?.attempt.id === attempt.id),
        reason: blocker?.attempt.id === attempt.id ? blocker.reason : typeof attempt.error?.message === 'string' ? attempt.error.message : undefined,
      });
    }
    for (const node of nodes) {
      if (node.type !== 'employee' || team.nodeAttempts.some((attempt) => attempt.nodeId === node.id)) continue;
      /** 尚未启动的冻结员工仍可看到其分工，不创建占位会话。 */
      const role = team.run.roleSnapshots.find((entry) => entry.employeeId === node.data.employeeId);
      append(group, employeeIdentity(node.data.employeeId, role?.configuration, input.employees), { conversationId: null, title: node.data.title, createdAt: team.run.createdAt, status: 'pending', current: false });
    }
    if (team.run.mainConversationId && !group.employees.some((member) => member.entries.some((entry) => entry.conversationId === team.run.mainConversationId))) {
      teamConversationIds.add(team.run.mainConversationId);
      append(group, null, { conversationId: team.run.mainConversationId, title: zh ? '团队主会话' : 'Team conversation', createdAt: team.run.createdAt, status: '', current: false });
    }
    return group;
  });
  /** 独立指派与普通讨论始终保留真实访问入口。 */
  const independent: TaskConversationExecutionGroup = {
    id: independentConversationGroupId,
    name: zh ? '其他会话' : 'Other conversations',
    description: zh ? '独立指派与任务讨论' : 'Individual work and task discussions',
    team: null,
    employees: [],
  };
  /** 工作会话不会再次作为普通讨论列出。 */
  const workConversationIds = new Set<string>();
  for (const item of input.items)
    for (const run of item.runs) {
      if (run.conversationId) workConversationIds.add(run.conversationId);
      if (teamWorkIds.has(run.id) || (run.conversationId && teamConversationIds.has(run.conversationId))) continue;
      append(independent, employeeIdentity(run.employeeId, run.employeeSnapshot, input.employees), {
        conversationId: run.conversationId,
        title: item.title,
        createdAt: run.createdAt,
        status: run.status,
        current: item.currentRunId === run.id && ['prepared', 'dispatching', 'active', 'waiting_input', 'outcome_unknown'].includes(run.status),
        reason: run.errorMessage ?? item.arrangement?.blockedReason,
      });
    }
  for (const conversation of input.conversations) {
    if (teamConversationIds.has(conversation.id) || workConversationIds.has(conversation.id)) continue;
    append(independent, null, { conversationId: conversation.id, title: conversation.title, createdAt: conversation.createdAt, status: '', current: false });
  }
  groups.push(independent);
  for (const group of groups)
    for (const member of group.employees) member.entries.sort((a, b) => Number(b.current) - Number(a.current) || b.createdAt.localeCompare(a.createdAt) || (b.conversationId ?? '').localeCompare(a.conversationId ?? ''));
  return groups;
}

/** 导航状态文案不暴露内部运行次数。 */
export function taskConversationStatus(status: string, zh: boolean): string {
  /** 当前任务中会出现的流程与独立工作状态。 */
  const labels: Record<string, [string, string]> = {
    pending: ['未开始', 'Not started'],
    prepared: ['等待开始', 'Queued'],
    dispatching: ['正在启动', 'Starting'],
    active: ['执行中', 'Running'],
    waiting_input: ['等待输入', 'Waiting for input'],
    awaiting_approval: ['等待确认', 'Awaiting approval'],
    runtime_completed: ['待验收', 'Awaiting review'],
    succeeded: ['已完成', 'Completed'],
    failed: ['受阻', 'Blocked'],
    outcome_unknown: ['待核对', 'Unconfirmed'],
    changes_requested: ['待修改', 'Changes requested'],
    invalidated: ['已结束', 'Ended'],
    cancelled: ['已取消', 'Cancelled'],
  };
  return labels[status]?.[zh ? 0 : 1] ?? status;
}
