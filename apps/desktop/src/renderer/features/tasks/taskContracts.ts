import type { TaskAttachmentReference, TaskManagementStatus, TaskPriority, TaskType } from '@zeus/shared';
import type { GraphConversationHistoryItem } from '../graph/graphContracts.js';
import type { AiRuntimeSession } from '../runtime/runtimeContracts.js';

export type TaskStatus = 'draft' | 'ready' | 'running' | 'paused' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled';

export type TaskAgentRunStatus = 'not_started' | 'connecting' | 'reconnecting' | 'running' | 'waiting_user' | 'waiting_approval' | 'paused' | 'idle' | 'failed' | 'legacy_readonly';

export type TaskTableColumnKey =
  | 'code'
  | 'intent'
  | 'taskType'
  | 'managementStatus'
  | 'branchStatus'
  | 'runStatus'
  | 'source'
  | 'updatedAt'
  | 'createdAt'
  | 'template'
  | 'project'
  | 'priority'
  | 'description'
  | 'runtimeSession'
  | 'rawId'
  | 'createdFrom';

export type TaskTableColumnWidth = number;

export type TaskTableSortDirection = 'asc' | 'desc';

export interface TaskTableSortState {
  columnKey: TaskTableColumnKey | null;
  direction: TaskTableSortDirection | null;
}

export interface TaskTableColumnPreferences {
  visibleColumnKeys: TaskTableColumnKey[];
  columnOrder: TaskTableColumnKey[];
  columnWidths?: Partial<Record<TaskTableColumnKey, TaskTableColumnWidth>>;
  sort: TaskTableSortState;
}

export interface TaskTableEnumSortOrders {
  priority: TaskPriority[];
  managementStatus: TaskManagementStatus[];
  runStatus: TaskAgentRunStatus[];
}

export interface TaskRecord {
  id: string;
  projectId: string;
  taskCode?: string;
  taskSequence?: number | null;
  parentTaskId?: string | null;
  relatedTaskIds?: string[];
  title: string;
  taskType: TaskType;
  description?: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  managementStatus?: TaskManagementStatus;
  status: TaskStatus;
  priority?: string;
  templateId?: string | null;
  tags?: string[];
  createdFrom?: string;
  sourceContextJson?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TaskTemplateRecord {
  id: string;
  name: string;
  description: string;
  category?: string;
  promptTemplate: string;
  defaultOptionsJson?: string;
  projectId?: string | null;
  builtIn: boolean;
}

export interface TaskEventRecord {
  id: string;
  taskId: string;
  eventType: string;
  title: string;
  payloadJson: string;
  createdAt: string;
}

export type TaskWorkflowStatus = 'active' | 'completed' | 'cancelled';
export type TaskStageKind = 'plan' | 'implementation' | 'code_review' | 'custom';
export type TaskStageStatus = 'pending' | 'ready' | 'running' | 'awaiting_acceptance' | 'accepted' | 'changes_requested' | 'failed' | 'cancelled' | 'skipped';
export type TaskStageAttemptStatus = 'starting' | 'active' | 'completed' | 'failed' | 'outcome_unknown' | 'cancelled';
export type TaskStageDeliverableStatus = 'submitted' | 'accepted' | 'changes_requested' | 'superseded';
export type TaskStageAdvanceMode = 'manual' | 'auto';
export type TaskStageAgentKind = 'codex' | 'pi';
export type TaskStagePermissionMode = 'read-only' | 'auto' | 'full-access';
export type TaskStageWorkMode = 'default' | 'plan';

export interface TaskWorkflowRecord {
  id: string;
  taskId: string;
  templateKey: string;
  templateRevision: number;
  status: TaskWorkflowStatus;
  currentStageId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStageAttemptRecord {
  id: string;
  taskId: string;
  stageId: string;
  attemptNumber: number;
  operationIdentity: string;
  conversationId: string | null;
  submissionId: string | null;
  segmentId: string | null;
  workspaceId: string | null;
  environmentId: string | null;
  agentKind: TaskStageAgentKind;
  modelRef: string;
  effort: string | null;
  serviceTier: string | null;
  workMode: TaskStageWorkMode;
  permissionMode: TaskStagePermissionMode;
  inputDeliverableIds: string[];
  sourceSnapshotJson: string;
  status: TaskStageAttemptStatus;
  errorJson: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStageDeliverableRecord {
  id: string;
  taskId: string;
  stageId: string;
  attemptId: string;
  version: number;
  kind: string;
  title: string;
  summary: string;
  mimeType: string;
  artifactSha256: string;
  artifactRefJson: string;
  contentSha256: string;
  contentByteLength: number;
  operationIdentity: string;
  status: TaskStageDeliverableStatus;
  decisionReason: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStageRecord {
  id: string;
  workflowId: string;
  taskId: string;
  stageKey: string;
  sequence: number;
  kind: TaskStageKind;
  title: string;
  description: string;
  status: TaskStageStatus;
  agentKind: TaskStageAgentKind;
  modelRef: string;
  effort: string | null;
  serviceTier: string | null;
  workMode: TaskStageWorkMode;
  permissionMode: TaskStagePermissionMode;
  advanceMode: TaskStageAdvanceMode;
  prompt: string;
  outputContractJson: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  attempts: TaskStageAttemptRecord[];
  deliverables: TaskStageDeliverableRecord[];
}

export interface TaskWorkflowSnapshot {
  workflow: TaskWorkflowRecord;
  stages: TaskStageRecord[];
}

export interface CreateTaskStageRequest {
  stageKey: string;
  kind: TaskStageKind;
  title: string;
  description: string;
  agentKind: TaskStageAgentKind;
  modelRef: string;
  effort?: string | null;
  serviceTier?: string | null;
  workMode: TaskStageWorkMode;
  permissionMode: TaskStagePermissionMode;
  advanceMode: TaskStageAdvanceMode;
  prompt: string;
  outputContract: Record<string, unknown>;
}

export interface UpdateTaskStageRequest {
  expectedRevision: number;
  title?: string;
  description?: string;
  agentKind?: TaskStageAgentKind;
  modelRef?: string;
  effort?: string | null;
  serviceTier?: string | null;
  workMode?: TaskStageWorkMode;
  permissionMode?: TaskStagePermissionMode;
  advanceMode?: TaskStageAdvanceMode;
  prompt?: string;
  outputContract?: Record<string, unknown>;
}

export interface CreateTaskRequest {
  idempotencyKey: string;
  projectId: string;
  parentTaskId?: string | null;
  title: string;
  taskType: TaskType;
  description: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  sourceContext: Record<string, unknown>;
  tags?: string[];
  priority: TaskPriority;
}

export interface UpdateTaskRelationshipsRequest {
  expectedUpdatedAt: string;
  parentTaskId?: string | null;
  relatedTaskIds?: string[];
}

export interface DeleteTaskRequest {
  childStrategy?: 'reparent' | 'delete_descendants' | 'make_roots';
  replacementParentTaskId?: string;
}

export interface DeleteTaskResult {
  task: TaskRecord;
  deletedTaskIds: string[];
  movedChildTaskIds: string[];
}

export interface LoadTasksRequest {
  projectId: string;
  query?: string;
  managementStatus?: TaskManagementStatus;
  tag?: string;
  sortBy?: 'createdAt' | 'updatedAt' | 'title' | 'taskType' | 'managementStatus';
  sortDirection?: 'asc' | 'desc';
}

export interface UpdateTaskRequest {
  expectedUpdatedAt: string;
  title?: string;
  taskType?: TaskType;
  description?: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  priority?: TaskPriority;
  tags?: string[];
  attachments?: TaskAttachmentReference[];
  sourceContext?: Record<string, unknown>;
  allowCodeChanges?: boolean;
  allowTests?: boolean;
  allowGitCommit?: boolean;
}

export interface CreateTaskFromGraphNodeRequest {
  projectId: string;
  intent?: string;
  idempotencyKey: string;
}

export interface CreateProjectGraphTaskRequest {
  intent?: string;
}

export interface LinkGraphNodeRequest {
  nodeId: string;
  reason?: string;
}

export interface CreateTaskTemplateRequest {
  projectId?: string;
  name: string;
  description: string;
  promptTemplate: string;
  category?: string;
  defaultOptions?: Record<string, unknown>;
}

export interface CreateTaskFromTemplateRequest {
  idempotencyKey: string;
  projectId: string;
  title?: string;
  variables?: Record<string, string>;
}

export interface TaskRuntimeControlResult {
  task: TaskRecord;
  conversation: GraphConversationHistoryItem;
  runtimeSession?: AiRuntimeSession;
  runtimeError?: {
    message: string;
  };
  queued?: true;
  reason?: string;
}
