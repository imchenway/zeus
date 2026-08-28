import type { TaskWorkflowSnapshot } from '../tasks/taskContracts.js';

export type DigitalEmployeeAgentKind = 'codex' | 'pi';
export type DigitalEmployeePermissionMode = 'read-only' | 'auto' | 'full-access';
export type DigitalEmployeeWorkMode = 'default' | 'plan';
export type DigitalEmployeeAutomationTriggerKind = 'immediate' | 'once' | 'daily' | 'weekly' | 'interval' | 'task_created' | 'task_updated' | 'task_status_changed' | 'code_changed';
export type DigitalEmployeeAutomationActionKind = 'assign_task' | 'create_and_assign_task' | 'explore_project';
export type DigitalEmployeeExecutionStatus = 'queued' | 'dispatching' | 'running' | 'waiting' | 'delivery_pending' | 'delivered' | 'blocked' | 'failed' | 'cancelled';
export type DigitalEmployeeDeliveryStage = 'none' | 'commit' | 'push' | 'merge' | 'deploy' | 'complete' | 'done';
export type DigitalEmployeeExecutionMode = 'legacy_single_conversation' | 'staged';

export interface DigitalEmployeeDeliveryGrants {
  allowCommit: boolean;
  allowPush: boolean;
  allowMerge: boolean;
  allowDeploy: boolean;
  allowComplete: boolean;
}

export interface DigitalEmployeeTemplateRecord {
  id: string;
  name: string;
  description: string;
  role: string;
  domain: string;
  /** 首版只返回零或一个默认 Zeus Skill 稳定身份。 */
  skillIds: string[];
  prompt: string;
  agentKind: DigitalEmployeeAgentKind;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  permissionMode: DigitalEmployeePermissionMode;
  workMode: DigitalEmployeeWorkMode;
  builtIn: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface DigitalEmployeeTaskFilter {
  managementStatuses: string[];
  taskTypes: string[];
  requiredTags: string[];
}

export interface DigitalEmployeeRecord extends Omit<DigitalEmployeeTemplateRecord, 'builtIn'> {
  projectId: string;
  templateId: string | null;
  enabled: boolean;
  autoClaim: boolean;
  autonomousExploration: boolean;
  maxConcurrency: number;
  taskFilter: DigitalEmployeeTaskFilter;
  allowCodeChanges: boolean;
  allowTests: boolean;
  deliveryGrants: DigitalEmployeeDeliveryGrants;
  deployCommandId: string | null;
}

export interface DigitalEmployeeAutomationRecord {
  id: string;
  projectId: string;
  employeeId: string;
  name: string;
  enabled: boolean;
  triggerKind: DigitalEmployeeAutomationTriggerKind;
  triggerConfig: Record<string, unknown>;
  actionKind: DigitalEmployeeAutomationActionKind;
  actionConfig: Record<string, unknown>;
  nextRunAt: string | null;
  cursorSequence: number;
  lastTriggeredAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface DigitalEmployeeExecutionRecord {
  id: string;
  projectId: string;
  taskId: string;
  employeeId: string;
  templateId: string | null;
  automationId: string | null;
  source: 'manual' | 'task_pool' | 'exploration' | 'automation';
  sourceRef: string | null;
  status: DigitalEmployeeExecutionStatus;
  executionMode: DigitalEmployeeExecutionMode;
  workflowId: string | null;
  currentStageId: string | null;
  revision: number;
  employeeSnapshot: DigitalEmployeeRecord;
  deliveryGrantsSnapshot: DigitalEmployeeDeliveryGrants;
  conversationId: string | null;
  environmentId: string | null;
  deliveryStage: DigitalEmployeeDeliveryStage;
  deliveryState: Record<string, unknown>;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DigitalEmployeeCollaborationProjection {
  execution: DigitalEmployeeExecutionRecord | null;
  workflow: TaskWorkflowSnapshot | null;
  blockingReasons: Array<{ code: string; message: string }>;
  legacyAdoptionAvailable: boolean;
}

export interface DigitalEmployeeStageDecisionInput {
  sourceStageId: string;
  deliverableId: string;
  deliverableVersion: number;
  expectedExecutionRevision: number;
  expectedSourceStageRevision: number;
}

export interface DigitalEmployeeTemplateInput {
  name: string;
  description?: string;
  role: string;
  domain?: string;
  skillIds?: string[];
  prompt: string;
  agentKind?: DigitalEmployeeAgentKind;
  model?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  permissionMode?: DigitalEmployeePermissionMode;
  workMode?: DigitalEmployeeWorkMode;
}

export interface DigitalEmployeeInput extends DigitalEmployeeTemplateInput {
  enabled?: boolean;
  autoClaim?: boolean;
  autonomousExploration?: boolean;
  maxConcurrency?: number;
  taskFilter?: Partial<DigitalEmployeeTaskFilter>;
  allowCodeChanges?: boolean;
  allowTests?: boolean;
  deliveryGrants?: Partial<DigitalEmployeeDeliveryGrants>;
  deployCommandId?: string | null;
}

export interface DigitalEmployeeAutomationInput {
  employeeId: string;
  name: string;
  enabled?: boolean;
  triggerKind: DigitalEmployeeAutomationTriggerKind;
  triggerConfig?: Record<string, unknown>;
  actionKind: DigitalEmployeeAutomationActionKind;
  actionConfig?: Record<string, unknown>;
  nextRunAt?: string | null;
}
