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
