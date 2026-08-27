import type {
  DigitalEmployeeAutomationActionKind,
  DigitalEmployeeAutomationTriggerKind,
  DigitalEmployeeExecutionRecord,
  DigitalEmployeeExecutionStatus,
  DigitalEmployeeInput,
  DigitalEmployeeRecord,
  DigitalEmployeeTemplateInput,
  DigitalEmployeeTemplateRecord,
} from './digitalEmployeeContracts.js';

export type DigitalEmployeeLanguage = 'zh-CN' | 'en-US';

export interface DigitalEmployeeTemplateDraft {
  name: string;
  description: string;
  role: string;
  domain: string;
  skillId: string;
  prompt: string;
  agentKind: 'codex' | 'pi';
  model: string;
  reasoningEffort: string;
  serviceTier: string;
  permissionMode: 'read-only' | 'auto' | 'full-access';
  workMode: 'default' | 'plan';
}

export interface DigitalEmployeeDraft extends DigitalEmployeeTemplateDraft {
  enabled: boolean;
  autoClaim: boolean;
  autonomousExploration: boolean;
  maxConcurrency: string;
  managementStatuses: string;
  taskTypes: string;
  requiredTags: string;
  allowCodeChanges: boolean;
  allowTests: boolean;
  allowCommit: boolean;
  allowPush: boolean;
  allowMerge: boolean;
  allowDeploy: boolean;
  allowComplete: boolean;
  deployCommandId: string;
}

export interface DigitalEmployeeAutomationDraft {
  employeeId: string;
  name: string;
  triggerKind: DigitalEmployeeAutomationTriggerKind;
  actionKind: DigitalEmployeeAutomationActionKind;
  runAt: string;
  time: string;
  weekday: string;
  intervalMinutes: string;
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  taskType: 'requirement' | 'defect' | 'optimization';
  tags: string;
}

export const emptyTemplateDraft: DigitalEmployeeTemplateDraft = {
  name: '',
  description: '',
  role: '',
  domain: '',
  skillId: '',
  prompt: '',
  agentKind: 'codex',
  model: '',
  reasoningEffort: '',
  serviceTier: '',
  permissionMode: 'read-only',
  workMode: 'default',
};

export const emptyAutomationDraft: DigitalEmployeeAutomationDraft = {
  employeeId: '',
  name: '',
  triggerKind: 'daily',
  actionKind: 'explore_project',
  runAt: '',
  time: '09:00',
  weekday: '1',
  intervalMinutes: '60',
  taskId: '',
  taskTitle: '',
  taskDescription: '',
  taskType: 'requirement',
  tags: '数字员工',
};

export function templateDraft(record?: DigitalEmployeeTemplateRecord | DigitalEmployeeRecord): DigitalEmployeeTemplateDraft {
  if (!record) return { ...emptyTemplateDraft };
  return {
    name: record.name,
    description: record.description,
    role: record.role,
    domain: record.domain,
    skillId: record.skillIds[0] ?? '',
    prompt: record.prompt,
    agentKind: record.agentKind,
    model: record.model ?? '',
    reasoningEffort: record.reasoningEffort ?? '',
    serviceTier: record.serviceTier ?? '',
    permissionMode: record.permissionMode,
    workMode: record.workMode,
  };
}

export function employeeDraft(record: DigitalEmployeeRecord): DigitalEmployeeDraft {
  return {
    ...templateDraft(record),
    enabled: record.enabled,
    autoClaim: record.autoClaim,
    autonomousExploration: record.autonomousExploration,
    maxConcurrency: String(record.maxConcurrency),
    managementStatuses: record.taskFilter.managementStatuses.join(', '),
    taskTypes: record.taskFilter.taskTypes.join(', '),
    requiredTags: record.taskFilter.requiredTags.join(', '),
    allowCodeChanges: record.allowCodeChanges,
    allowTests: record.allowTests,
    allowCommit: record.deliveryGrants.allowCommit,
    allowPush: record.deliveryGrants.allowPush,
    allowMerge: record.deliveryGrants.allowMerge,
    allowDeploy: record.deliveryGrants.allowDeploy,
    allowComplete: record.deliveryGrants.allowComplete,
    deployCommandId: record.deployCommandId ?? '',
  };
}

export function templateInput(draft: DigitalEmployeeTemplateDraft): DigitalEmployeeTemplateInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    role: draft.role.trim(),
    domain: draft.domain.trim(),
    skillIds: draft.skillId ? [draft.skillId] : [],
    prompt: draft.prompt.trim(),
    agentKind: draft.agentKind,
    model: nullable(draft.model),
    reasoningEffort: nullable(draft.reasoningEffort),
    serviceTier: nullable(draft.serviceTier),
    permissionMode: draft.permissionMode,
    workMode: draft.workMode,
  };
}

export function employeeInput(draft: DigitalEmployeeDraft): DigitalEmployeeInput {
  return {
    ...templateInput(draft),
    enabled: draft.enabled,
    autoClaim: draft.autoClaim,
    autonomousExploration: draft.autonomousExploration,
    maxConcurrency: Number.parseInt(draft.maxConcurrency, 10),
    taskFilter: {
      managementStatuses: splitList(draft.managementStatuses),
      taskTypes: splitList(draft.taskTypes),
      requiredTags: splitList(draft.requiredTags),
    },
    allowCodeChanges: draft.allowCodeChanges,
    allowTests: draft.allowTests,
    deliveryGrants: {
      allowCommit: draft.allowCommit,
      allowPush: draft.allowPush,
      allowMerge: draft.allowMerge,
      allowDeploy: draft.allowDeploy,
      allowComplete: draft.allowComplete,
    },
    deployCommandId: nullable(draft.deployCommandId),
  };
}

export function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,，]/u)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export function nullable(value: string): string | null {
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function formatDateTime(value: string | null | undefined, language: DigitalEmployeeLanguage): string {
  if (!value) return language === 'zh-CN' ? '未记录' : 'Not recorded';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

export function executionStatusLabel(status: DigitalEmployeeExecutionStatus, language: DigitalEmployeeLanguage): string {
  const zh: Record<DigitalEmployeeExecutionStatus, string> = {
    queued: '排队中',
    dispatching: '正在派发',
    running: '处理中',
    waiting: '等待处理',
    delivery_pending: '正在交付',
    delivered: '已交付',
    blocked: '已阻塞',
    failed: '失败',
    cancelled: '已取消',
  };
  const en: Record<DigitalEmployeeExecutionStatus, string> = {
    queued: 'Queued',
    dispatching: 'Dispatching',
    running: 'Running',
    waiting: 'Waiting',
    delivery_pending: 'Delivering',
    delivered: 'Delivered',
    blocked: 'Blocked',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  return (language === 'zh-CN' ? zh : en)[status];
}

export function executionIsActive(execution: DigitalEmployeeExecutionRecord): boolean {
  return ['queued', 'dispatching', 'running', 'waiting', 'delivery_pending'].includes(execution.status);
}

export function triggerLabel(trigger: DigitalEmployeeAutomationTriggerKind, language: DigitalEmployeeLanguage): string {
  const zh: Record<DigitalEmployeeAutomationTriggerKind, string> = {
    immediate: '立即一次',
    once: '指定时间一次',
    daily: '每天',
    weekly: '每周',
    interval: '固定间隔',
    task_created: '任务创建',
    task_updated: '任务内容变化',
    task_status_changed: '任务状态变化',
    code_changed: '代码变化',
  };
  const en: Record<DigitalEmployeeAutomationTriggerKind, string> = {
    immediate: 'Run once now',
    once: 'Run once later',
    daily: 'Daily',
    weekly: 'Weekly',
    interval: 'Interval',
    task_created: 'Task created',
    task_updated: 'Task content changed',
    task_status_changed: 'Task status changed',
    code_changed: 'Code changed',
  };
  return (language === 'zh-CN' ? zh : en)[trigger];
}

export function actionLabel(action: DigitalEmployeeAutomationActionKind, language: DigitalEmployeeLanguage): string {
  const zh: Record<DigitalEmployeeAutomationActionKind, string> = {
    assign_task: '认领或指派任务',
    create_and_assign_task: '创建并指派任务',
    explore_project: '只读探索项目',
  };
  const en: Record<DigitalEmployeeAutomationActionKind, string> = {
    assign_task: 'Claim or assign task',
    create_and_assign_task: 'Create and assign task',
    explore_project: 'Explore project read-only',
  };
  return (language === 'zh-CN' ? zh : en)[action];
}

export function localDateTimeToIso(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? '' : timestamp.toISOString();
}

export function automationTriggerConfig(draft: DigitalEmployeeAutomationDraft): Record<string, unknown> {
  if (draft.triggerKind === 'once') return { runAt: localDateTimeToIso(draft.runAt) };
  if (draft.triggerKind === 'interval') return { intervalMinutes: Number.parseInt(draft.intervalMinutes, 10) };
  if (draft.triggerKind === 'daily' || draft.triggerKind === 'weekly') {
    const [hour = '9', minute = '0'] = draft.time.split(':');
    return {
      hour: Number.parseInt(hour, 10),
      minute: Number.parseInt(minute, 10),
      ...(draft.triggerKind === 'weekly' ? { weekday: Number.parseInt(draft.weekday, 10) } : {}),
    };
  }
  if (draft.triggerKind === 'task_created' || draft.triggerKind === 'task_updated' || draft.triggerKind === 'task_status_changed') {
    return { ignoreAutomationCreated: true };
  }
  return {};
}

export function automationActionConfig(draft: DigitalEmployeeAutomationDraft): Record<string, unknown> {
  if (draft.actionKind === 'assign_task') {
    const eventTrigger = draft.triggerKind === 'task_created' || draft.triggerKind === 'task_updated' || draft.triggerKind === 'task_status_changed' || draft.triggerKind === 'code_changed';
    return {
      useEventTask: eventTrigger,
      ...(draft.taskId.trim() ? { taskId: draft.taskId.trim() } : {}),
    };
  }
  if (draft.actionKind === 'create_and_assign_task') {
    return {
      title: draft.taskTitle.trim(),
      description: draft.taskDescription.trim(),
      taskType: draft.taskType,
      tags: splitList(draft.tags),
    };
  }
  return {};
}
