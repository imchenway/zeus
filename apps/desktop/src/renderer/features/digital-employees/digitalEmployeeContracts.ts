import type { TaskPushMessageLayout } from '@zeus/shared';
import type { CodexTaskPushModelCapability, TaskPushSupplementalAttachmentInput } from '../../session/sessionTypes.js';
import type { TaskWorkflowSnapshot } from '../tasks/taskContracts.js';

export type DigitalEmployeeAgentKind = 'codex' | 'pi';
export type DigitalEmployeePermissionMode = 'read-only' | 'auto' | 'full-access';
export type DigitalEmployeeWorkMode = 'default' | 'plan';
export type DigitalEmployeeAutomationTriggerKind = 'immediate' | 'once' | 'daily' | 'weekly' | 'interval' | 'task_created' | 'task_updated' | 'task_status_changed' | 'code_changed';
export type DigitalEmployeeAutomationActionKind = 'assign_task' | 'create_and_assign_task' | 'explore_project';
export type DigitalEmployeeExecutionStatus = 'queued' | 'dispatching' | 'running' | 'waiting' | 'delivery_pending' | 'delivered' | 'blocked' | 'failed' | 'cancelled';
export type DigitalEmployeeDeliveryStage = 'none' | 'commit' | 'push' | 'merge' | 'deploy' | 'complete' | 'done';
export type DigitalEmployeeExecutionMode = 'legacy_single_conversation' | 'staged';

export interface ModelPolicyV1 {
  defaultMode: 'project' | 'explicit';
  defaultModel: string | null;
  allowedModels: string[];
  allowedReasoningEfforts: string[];
  allowedServiceTiers: string[];
}

export interface SkillPolicyV1 {
  allowedSkillIds: string[];
}

export interface AuthorityPolicyV1 {
  permissionMode: DigitalEmployeePermissionMode;
  allowCodeChanges: boolean;
  allowTests: boolean;
  allowCommit: boolean;
  allowPush: boolean;
  allowMerge: boolean;
  allowDeploy: boolean;
  allowComplete: boolean;
}

export interface AgentEntrypointV2 {
  kind: 'agent';
  prompt: string;
  agentKind: DigitalEmployeeAgentKind;
  modelPolicy: ModelPolicyV1;
  skillPolicy: SkillPolicyV1;
  authorityPolicy: AuthorityPolicyV1;
}

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
  /** 允许的 Zeus Skill 稳定身份集合。 */
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
  entrypoint: AgentEntrypointV2 | null;
  entrypointMigrationState: 'ready' | 'requires_selection' | 'requires_configuration';
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

export interface DigitalEmployeeCapabilitiesSnapshot {
  generationId: string;
  initializedAt: string;
  models: CodexTaskPushModelCapability[];
  available?: false;
  availabilityReason?: string;
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
  entrypoint?: AgentEntrypointV2 | null;
}

export type TaskWorkItemStatus = 'queued' | 'active' | 'waiting_manager' | 'completed' | 'blocked' | 'failed' | 'cancelled';
export type TaskWorkRunStatus = 'prepared' | 'dispatching' | 'active' | 'waiting_input' | 'runtime_completed' | 'succeeded' | 'failed' | 'outcome_unknown' | 'cancelled';
export type TaskWorkDeliverableStatus = 'submitted' | 'accepted' | 'changes_requested' | 'superseded';
export type TaskWorkDecisionStatus = 'pending' | 'resolved' | 'dismissed' | 'expired';

export type TaskWorkWorkspaceChoice = { mode: 'create' } | { mode: 'existing'; environmentId: string } | { mode: 'local'; branchName: string };
export type TaskWorkWorkspaceSnapshot =
  | { mode: 'direct' }
  | { mode: 'existing'; environmentId: string }
  | { mode: 'local'; repositoryRevision: string; repositories: Array<{ repositoryId: string; branchName: string }> }
  | { mode: 'create'; repositoryRevision: string; repositories: Array<{ repositoryId: string; sourceRef: string; branchName: string }> };

export interface TaskWorkRunRecord {
  id: string;
  projectId: string;
  taskId: string;
  workItemId: string;
  employeeId: string;
  attempt: number;
  status: TaskWorkRunStatus;
  entrypointKind: 'agent' | 'command';
  employeeRevision: number;
  employeeSnapshot: Record<string, unknown>;
  entrypointSnapshot: Record<string, unknown>;
  modelSnapshot: Record<string, unknown> | null;
  skillSnapshot: Record<string, unknown>;
  authoritySnapshot: Record<string, unknown>;
  contextManifest: Record<string, unknown>;
  workspaceSnapshot: TaskWorkWorkspaceSnapshot | null;
  environmentId: string | null;
  enabledSkillIds: string[];
  conversationId: string | null;
  commandRunId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  runtimeCompletedAt: string | null;
  completedAt: string | null;
}

export interface TaskWorkDeliverableRecord {
  id: string;
  projectId: string;
  taskId: string;
  workItemId: string;
  runId: string;
  version: number;
  status: TaskWorkDeliverableStatus;
  kind: string;
  title: string;
  summary: string;
  artifactSha256: string;
  contentSha256: string;
  sourceMessageId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
}

export interface TaskWorkItemRecord {
  id: string;
  projectId: string;
  taskId: string;
  employeeId: string;
  source: 'manual' | 'automation';
  sourceRef: string | null;
  title: string;
  description: string;
  entrypointKind: 'agent' | 'command';
  status: TaskWorkItemStatus;
  currentRunId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  runs: TaskWorkRunRecord[];
  deliverables: TaskWorkDeliverableRecord[];
}

export interface TaskWorkDecisionRecord {
  id: string;
  projectId: string;
  taskId: string;
  workItemId: string;
  runId: string | null;
  deliverableId: string | null;
  kind: 'input_required' | 'authorization' | 'deliverable_acceptance' | 'command_confirmation' | 'command_failure' | 'outcome_unknown';
  status: TaskWorkDecisionStatus;
  title: string;
  prompt: string;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown> | null;
  operationIdentity: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  expiresAt: string | null;
}

export interface TaskWorkConversationRequestRecord {
  id: string;
  conversationId: string;
  workItemId: string;
  runId: string;
  requestKind: 'command' | 'file' | 'permissions' | 'request_user_input' | 'mcp';
  createdAt: string;
  expiresAt: string | null;
}

export interface TaskWorkManagementProjection {
  summary: { workItems: number; activeWorkItems: number; pendingActions: number; submittedDeliverables: number; legacyExecutions: number };
  workItems: TaskWorkItemRecord[];
  relationships: Array<Record<string, unknown>>;
  conversationRequests: TaskWorkConversationRequestRecord[];
  managerDecisions: TaskWorkDecisionRecord[];
  deliverables: TaskWorkDeliverableRecord[];
  evidenceRefs: Array<Record<string, unknown>>;
  revision: string;
}

export interface TaskWorkPreviewSelection {
  employeeId: string;
  supplementalInfo?: string | null;
  supplementalAttachments?: TaskPushSupplementalAttachmentInput[];
  modelOverride?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  workMode?: DigitalEmployeeWorkMode | null;
  permissionMode?: DigitalEmployeePermissionMode | null;
  promptOverride?: string | null;
  skillIds?: string[];
  selectedDeliverableIds?: string[];
  workspace?: TaskWorkWorkspaceChoice;
}

export interface TaskWorkPreview {
  previewSha256: string;
  expiresAt: string;
  expectedTaskRevision: string;
  expectedEmployeeRevision: number;
  selection: TaskWorkPreviewSelection;
  employee: { id: string; name: string; role: string; domain: string; revision: number };
  entrypoint: Record<string, unknown> | null;
  model: Record<string, unknown> | null;
  skills: Array<
    | { source: 'skill'; id: string; name: string; description: string; directoryName: string; contentSha256: string; resourceCount: number; totalBytes: number }
    | { source: 'plugin'; id: string; name: string; description: string; pluginId: string; pluginRevisionId: string }
  >;
  authority: Record<string, unknown>;
  context: Record<string, unknown>;
  workspace: TaskWorkWorkspaceSnapshot | null;
  promptPreview: TaskPushMessageLayout | null;
  command: null | {
    id: string;
    title: string;
    revision: number;
    parameters: Array<{ key: string; label: string; description: string; type: string; required: boolean; sensitive: boolean; hasValue: boolean }>;
    safeParameterSnapshot: Record<string, string | number | boolean>;
    parameterDigest: string;
    riskFlags: Record<string, boolean>;
  };
  blockers: Array<{ code: string; message: string }>;
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
