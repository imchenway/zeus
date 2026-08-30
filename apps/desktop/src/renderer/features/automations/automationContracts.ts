export type AutomationStatus = 'active' | 'paused' | 'deleted';
export type AutomationTriggerKind = 'manual' | 'once' | 'interval' | 'daily' | 'weekly' | 'rrule' | 'event';
export type AutomationConversationMode = 'independent' | 'original';
export type AutomationBlockStrategy = 'serial' | 'discard' | 'cover';
export type AutomationPermissionMode = 'read-only' | 'auto' | 'full-access';
export type AutomationRunStatus = 'queued' | 'dispatching' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';

export interface AutomationTriggerConfig {
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
  id: string;
  automationId: string;
  automationRevisionId: string;
  projectId: string;
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
  modelSourceId: string;
  modelId: string;
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
