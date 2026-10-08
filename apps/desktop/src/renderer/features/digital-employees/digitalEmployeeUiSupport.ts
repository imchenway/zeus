import type { DigitalEmployeeAvatarId, EmployeeWorkSettings } from '@zeus/shared';
import { formatVisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import type {
  DigitalEmployeeAutomationActionKind,
  DigitalEmployeeAutomationTriggerKind,
  DigitalEmployeeExecutionRecord,
  DigitalEmployeeExecutionStatus,
  DigitalEmployeeRecord,
  DigitalEmployeeTemplateInput,
  DigitalEmployeeTemplateRecord,
} from './digitalEmployeeContracts.js';

export type DigitalEmployeeLanguage = 'zh-CN' | 'en-US';

/** 全局员工保存身份、提示词、执行默认值和记忆读取偏好。 */
export interface DigitalEmployeeTemplateDraft {
  /** 新工作继承的默认执行配置。 */
  settings: EmployeeWorkSettings;
  /** 员工显示名称。 */
  name: string;
  /** 员工职责说明。 */
  description: string;
  /** 员工岗位。 */
  role: string;
  /** 员工业务领域。 */
  domain: string;
  /** 预置头像身份。 */
  avatarId: DigitalEmployeeAvatarId | null;
  /** 员工通用提示词。 */
  prompt: string;
  /** 是否读取个人经验。 */
  memoryEnabled?: boolean;
}

/** 新员工从空白身份与提示词开始，默认读取已确认经验。 */
export const emptyTemplateDraft: DigitalEmployeeTemplateDraft = { settings: {}, memoryEnabled: true, name: '', description: '', role: '', domain: '', avatarId: null, prompt: '' };

/** 编辑草稿保留历史描述，不恢复已退役的行动授权。 */
export function templateDraft(record?: DigitalEmployeeTemplateRecord | DigitalEmployeeRecord): DigitalEmployeeTemplateDraft {
  if (!record) return { ...emptyTemplateDraft };
  return {
    settings: {
      modelOverride: record.model,
      reasoningEffort: record.reasoningEffort,
      contextCapacityTokens: record.contextCapacityTokens ?? null,
      serviceTier: record.serviceTier,
      workMode: record.workMode,
      permissionMode: record.permissionMode,
      skillIds: record.skillIds,
    },
    memoryEnabled: record.memoryEnabled !== false,
    name: record.name,
    description: record.description,
    role: record.role,
    domain: record.domain,
    avatarId: record.avatarId ?? null,
    prompt: record.prompt,
  };
}

/** 将默认执行配置写入现有员工存储。 */
export function templateInput(draft: DigitalEmployeeTemplateDraft): DigitalEmployeeTemplateInput {
  return {
    model: draft.settings.modelOverride ?? null,
    reasoningEffort: draft.settings.reasoningEffort ?? null,
    contextCapacityTokens: draft.settings.contextCapacityTokens ?? null,
    serviceTier: draft.settings.serviceTier ?? null,
    workMode: draft.settings.workMode ?? 'default',
    permissionMode: draft.settings.permissionMode ?? 'read-only',
    skillIds: draft.settings.skillIds ?? [],
    memoryEnabled: draft.memoryEnabled !== false,
    name: draft.name.trim(),
    description: draft.description.trim(),
    role: draft.role.trim(),
    domain: draft.domain.trim(),
    avatarId: draft.avatarId,
    prompt: draft.prompt.trim(),
  };
}

/** 显示当前语言的原因，并保留可展开的原始详情。 */
export function errorMessage(error: unknown, language: 'zh-CN' | 'en'): string {
  return formatVisibleApplicationError(error, language);
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
    dispatching: '正在启动',
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
    dispatching: 'Starting',
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
