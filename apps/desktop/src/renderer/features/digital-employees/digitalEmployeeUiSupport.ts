import type { DigitalEmployeeAvatarId } from '@zeus/shared';
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

/** 全局员工只保存身份、提示词和个人经验偏好。 */
export interface DigitalEmployeeTemplateDraft {
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
export const emptyTemplateDraft: DigitalEmployeeTemplateDraft = { memoryEnabled: true, name: '', description: '', role: '', domain: '', avatarId: null, prompt: '' };

/** 全局编辑仅复制身份与提示词，不带入历史执行配置。 */
export function templateDraft(record?: DigitalEmployeeTemplateRecord | DigitalEmployeeRecord): DigitalEmployeeTemplateDraft {
  if (!record) return { ...emptyTemplateDraft };
  return { memoryEnabled: record.memoryEnabled !== false, name: record.name, description: record.description, role: record.role, domain: record.domain, avatarId: record.avatarId ?? null, prompt: record.prompt };
}

/** 仅将全局身份、提示词与经验偏好发送给存储层。 */
export function templateInput(draft: DigitalEmployeeTemplateDraft): DigitalEmployeeTemplateInput {
  return { memoryEnabled: draft.memoryEnabled !== false, name: draft.name.trim(), description: draft.description.trim(), role: draft.role.trim(), domain: draft.domain.trim(), avatarId: draft.avatarId, prompt: draft.prompt.trim() };
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
