import type { AutomationDispatchTarget, AutomationActionConfig, AutomationExecutionReference, AutomationSourceEvent } from '@zeus/shared';
/** 自动化引用导航复用既有会话、任务详情和流程页面。 */
export type AutomationExecutionTarget = 'conversation' | 'task' | 'workflow';
/** 宿主和工具页面使用同一真实执行引用契约。 */
export type { AutomationExecutionReference } from '@zeus/shared';

export type AutomationStatus = 'active' | 'paused' | 'deleted';
export type AutomationTriggerKind = 'manual' | 'once' | 'interval' | 'daily' | 'weekly' | 'rrule' | 'event';
export type AutomationConversationMode = 'independent' | 'original';
export type AutomationBlockStrategy = 'serial' | 'discard' | 'cover';
export type AutomationPermissionMode = 'read-only' | 'auto' | 'full-access';
export type AutomationRunStatus = 'queued' | 'dispatching' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';

export interface AutomationTriggerConfig {
  /** 事件发生前的真实项目状态条件。 */
  beforeStatusId?: string;
  /** 事件发生后的真实项目状态条件。 */
  afterStatusId?: string;
  at?: string;
  everyMinutes?: number;
  localTime?: string;
  weekdays?: number[];
  rrule?: string;
  eventKinds?: string[];
}

export interface AutomationNotifications {
  success: boolean;
  failure: boolean;
  blocked: boolean;
}

export interface AutomationRunRecord {
  /** 冻结目标的逐项目接纳进度和准确引用。 */
  dispatchTargets: AutomationDispatchTarget[];
  /** 全部目标完成接纳或明确跳过后才有值。 */
  dispatchCompletedAt: string | null;
  /** 存量部分运行核对保留原状态和核对原因，不覆盖历史结论。 */
  dispatchReconciliation: { previousStatus: AutomationRunStatus; checkedAt: string; reason: string } | null;
  /** 员工工作或整个项目流程的实际执行身份。 */
  executionReferences: AutomationExecutionReference[];
  /** 本轮事件的发生时事实。 */
  sourceEvent: AutomationSourceEvent | null;
  id: string;
  automationId: string;
  automationRevisionId: string;
  projectId: string;
  /** 本次触发在同一会话内处理的全部项目。 */
  projectIds: string[];
  triggerKind: string;
  triggerIdentity: string;
  causalChainId: string;
  status: AutomationRunStatus;
  queuePosition: number | null;
  conversationId: string | null;
  submissionId: string | null;
  attempt: number;
  unread: boolean;
  mayOverlapPrevious: boolean;
  previousRunId: string | null;
  scheduledAt: string;
  acceptedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationTaskRecord {
  /** 无法安全更正的迁移定义需要用户明确核对任务选择。 */
  migrationIssue: string | null;
  /** 自动化执行动作。 */
  action: AutomationActionConfig;
  /** 按项目保存的事件消费边界。 */
  eventCursors: Record<string, number>;
  id: string;
  name: string;
  description: string;
  prompt: string;
  status: AutomationStatus;
  currentRevisionId: string;
  revision: number;
  triggerKind: AutomationTriggerKind;
  triggerConfig: AutomationTriggerConfig;
  timezone: string;
  conversationMode: AutomationConversationMode;
  originalConversationId: string | null;
  permissionMode: AutomationPermissionMode;
  modelSourceId: string;
  modelId: string;
  reasoningEffort: string | null;
  serviceTier: string | null;
  fastMode: boolean;
  skillId: string | null;
  pluginIds: string[];
  blockStrategy: AutomationBlockStrategy;
  queueCapacity: number;
  maxRunsPerDay: number | null;
  maxTokensPerDay: number | null;
  retentionDays: number;
  notifications: AutomationNotifications;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  projectIds: string[];
  runs: AutomationRunRecord[];
}

export interface AutomationTaskInput {
  /** 业务动作和员工引用。 */
  action?: AutomationActionConfig;
  name: string;
  description?: string;
  prompt: string;
  projectIds: string[];
  triggerKind?: AutomationTriggerKind;
  triggerConfig?: AutomationTriggerConfig;
  timezone?: string;
  conversationMode?: AutomationConversationMode;
  originalConversationId?: string | null;
  permissionMode?: AutomationPermissionMode;
  /** 历史字段，新规则执行继承统一默认。 */
  modelSourceId?: string;
  /** 历史字段，新规则执行继承统一默认。 */
  modelId?: string;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  fastMode?: boolean;
  skillId?: string | null;
  pluginIds?: string[];
  blockStrategy?: AutomationBlockStrategy;
  queueCapacity?: number;
  maxRunsPerDay?: number | null;
  maxTokensPerDay?: number | null;
  retentionDays?: number;
  notifications?: AutomationNotifications;
}
