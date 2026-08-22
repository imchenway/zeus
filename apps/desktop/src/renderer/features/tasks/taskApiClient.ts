import type { TaskBoardMoveRequest, TaskBoardViewSettings, TaskBoardViewSnapshot, TaskManagementStatus } from '@zeus/shared';
import type { CreateTaskRequest, DeleteTaskRequest, DeleteTaskResult, LoadTasksRequest, TaskEventRecord, TaskRecord, TaskRuntimeControlResult, TaskStatus, UpdateTaskRelationshipsRequest, UpdateTaskRequest } from './taskContracts.js';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { buildWorkManagementCommandRequest, workManagementClientCommandTypes } from '../work-management/workManagementCommandClient.js';

export interface TaskApiClient {
  createTask: (input: CreateTaskRequest) => Promise<TaskRecord>;
  loadTasks: (input: LoadTasksRequest) => Promise<TaskRecord[]>;
  loadTaskBoard: (projectId: string) => Promise<TaskBoardViewSnapshot>;
  updateTaskBoard: (projectId: string, expectedRevision: number, settings: Partial<TaskBoardViewSettings>) => Promise<TaskBoardViewSnapshot>;
  moveTaskBoardTask: (projectId: string, input: TaskBoardMoveRequest) => Promise<{ task: TaskRecord; board: TaskBoardViewSnapshot }>;
  loadTask: (taskId: string) => Promise<TaskRecord>;
  updateTask: (taskId: string, input: UpdateTaskRequest) => Promise<TaskRecord>;
  updateTaskRelationships: (taskId: string, input: UpdateTaskRelationshipsRequest) => Promise<TaskRecord>;
  updateTaskTags: (taskId: string, tags: string[], expectedUpdatedAt: string) => Promise<TaskRecord>;
  deleteTask: (taskId: string, input?: DeleteTaskRequest) => Promise<DeleteTaskResult>;
  runTask: (taskId: string) => Promise<TaskRuntimeControlResult>;
  pauseTask: (taskId: string) => Promise<TaskRecord>;
  continueTask: (taskId: string) => Promise<TaskRuntimeControlResult>;
  cancelTask: (taskId: string) => Promise<TaskRecord>;
  retryTask: (taskId: string) => Promise<TaskRecord>;
  loadArchivedTasks: (projectId: string) => Promise<TaskRecord[]>;
  loadTaskEvents: (taskId: string) => Promise<TaskEventRecord[]>;
  updateTaskStatus: (taskId: string, status: TaskStatus) => Promise<TaskRecord>;
  updateTaskManagementStatus: (taskId: string, status: TaskManagementStatus, expectedUpdatedAt: string, confirmWorktreeCleanup?: boolean, reopenConversationId?: string) => Promise<TaskRecord>;
  archiveTask: (taskId: string) => Promise<TaskRecord>;
  restoreTask: (taskId: string) => Promise<TaskRecord>;
}

export function createTaskApiClient(transport: LocalApiTransport): TaskApiClient {
  return {
    createTask: async (input) => {
      const { idempotencyKey, ...body } = input;
      const commandBody = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskCreate,
        scopeKind: 'task',
        scopeId: (operationIdentity) => operationIdentity,
        operationPrefix: 'task_',
        operationSeed: idempotencyKey,
        value: body,
      });
      return transport.request<TaskRecord>('/api/tasks', jsonRequest('POST', commandBody));
    },
    loadTasks: (input) => {
      const query = new URLSearchParams({ projectId: input.projectId });
      if (input.query) query.set('query', input.query);
      if (input.managementStatus) query.set('managementStatus', input.managementStatus);
      if (input.tag) query.set('tag', input.tag);
      if (input.sortBy) query.set('sortBy', input.sortBy);
      if (input.sortDirection) query.set('sortDirection', input.sortDirection);
      return transport.request<TaskRecord[]>(`/api/tasks?${query.toString()}`);
    },
    loadTaskBoard: (projectId) => transport.request<TaskBoardViewSnapshot>(`${projectPath(projectId)}/task-board`),
    updateTaskBoard: async (projectId, expectedRevision, settings) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskBoardUpdate,
        scopeKind: 'project',
        scopeId: () => projectId,
        expectedRevision,
        operationPrefix: 'task_board_update_',
        value: { expectedRevision, settings },
      });
      return transport.request<TaskBoardViewSnapshot>(`${projectPath(projectId)}/task-board`, jsonRequest('PATCH', body));
    },
    moveTaskBoardTask: async (projectId, input) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskBoardMove,
        scopeKind: 'project',
        scopeId: () => projectId,
        expectedRevision: input.expectedViewRevision,
        operationPrefix: 'task_board_move_',
        value: input,
      });
      return transport.request<{ task: TaskRecord; board: TaskBoardViewSnapshot }>(`${projectPath(projectId)}/task-board/moves`, jsonRequest('POST', body));
    },
    loadTask: (taskId) => transport.request<TaskRecord>(taskPath(taskId)),
    updateTask: async (taskId, input) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskUpdate,
        scopeKind: 'task',
        scopeId: () => taskId,
        operationPrefix: 'task_update_',
        value: input,
      });
      return transport.request<TaskRecord>(taskPath(taskId), jsonRequest('PATCH', body));
    },
    updateTaskRelationships: async (taskId, input) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskRelationshipsUpdate,
        scopeKind: 'task',
        scopeId: () => taskId,
        operationPrefix: 'task_relationships_update_',
        value: input,
      });
      return transport.request<TaskRecord>(`${taskPath(taskId)}/relationships`, jsonRequest('PATCH', body));
    },
    updateTaskTags: async (taskId, tags, expectedUpdatedAt) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskTagsUpdate,
        scopeKind: 'task',
        scopeId: () => taskId,
        operationPrefix: 'task_tags_update_',
        value: { tags, expectedUpdatedAt },
      });
      return transport.request<TaskRecord>(`${taskPath(taskId)}/tags`, jsonRequest('PUT', body));
    },
    deleteTask: async (taskId, input = {}) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskDelete,
        scopeKind: 'task',
        scopeId: () => taskId,
        operationPrefix: 'task_delete_',
        value: input,
      });
      return transport.request<DeleteTaskResult>(taskPath(taskId), jsonRequest('DELETE', body));
    },
    runTask: async (taskId) => transport.request<TaskRuntimeControlResult>(`${taskPath(taskId)}/run`, jsonRequest('POST', await emptyTaskCommand(taskId, workManagementClientCommandTypes.taskRun, 'task_run_'))),
    pauseTask: async (taskId) => transport.request<TaskRecord>(`${taskPath(taskId)}/pause`, jsonRequest('POST', await emptyTaskCommand(taskId, workManagementClientCommandTypes.taskPause, 'task_pause_'))),
    continueTask: async (taskId) => transport.request<TaskRuntimeControlResult>(`${taskPath(taskId)}/continue`, jsonRequest('POST', await emptyTaskCommand(taskId, workManagementClientCommandTypes.taskContinue, 'task_continue_'))),
    cancelTask: async (taskId) => transport.request<TaskRecord>(`${taskPath(taskId)}/cancel`, jsonRequest('POST', await emptyTaskCommand(taskId, workManagementClientCommandTypes.taskCancel, 'task_cancel_'))),
    retryTask: async (taskId) => transport.request<TaskRecord>(`${taskPath(taskId)}/retry`, jsonRequest('POST', await emptyTaskCommand(taskId, workManagementClientCommandTypes.taskRetry, 'task_retry_'))),
    loadArchivedTasks: (projectId) => transport.request<TaskRecord[]>(`/api/tasks/archived?projectId=${encodeURIComponent(projectId)}`),
    loadTaskEvents: (taskId) => transport.request<TaskEventRecord[]>(`${taskPath(taskId)}/events`),
    updateTaskStatus: async (taskId, status) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskStatusUpdate,
        scopeKind: 'task',
        scopeId: () => taskId,
        operationPrefix: 'task_status_update_',
        value: { status },
      });
      return transport.request<TaskRecord>(`${taskPath(taskId)}/status`, jsonRequest('PATCH', body));
    },
    updateTaskManagementStatus: async (taskId, status, expectedUpdatedAt, confirmWorktreeCleanup, reopenConversationId) => {
      const value = {
        status,
        expectedUpdatedAt,
        ...(confirmWorktreeCleanup === true ? { confirmWorktreeCleanup: true } : {}),
        ...(reopenConversationId ? { reopenConversationId } : {}),
      };
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskManagementStatusUpdate,
        scopeKind: 'task',
        scopeId: () => taskId,
        operationPrefix: 'task_management_status_update_',
        value,
      });
      return transport.request<TaskRecord>(`${taskPath(taskId)}/management-status`, jsonRequest('PATCH', body));
    },
    archiveTask: async (taskId) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskArchive,
        scopeKind: 'task',
        scopeId: () => taskId,
        operationPrefix: 'task_archive_',
        value: {},
      });
      return transport.request<TaskRecord>(`${taskPath(taskId)}/archive`, jsonRequest('POST', body));
    },
    restoreTask: async (taskId) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskRestore,
        scopeKind: 'task',
        scopeId: () => taskId,
        operationPrefix: 'task_restore_',
        value: {},
      });
      return transport.request<TaskRecord>(`${taskPath(taskId)}/restore`, jsonRequest('POST', body));
    },
  };
}

function emptyTaskCommand(taskId: string, commandType: (typeof workManagementClientCommandTypes)['taskRetry' | 'taskRun' | 'taskPause' | 'taskContinue' | 'taskCancel'], operationPrefix: string) {
  return buildWorkManagementCommandRequest({ commandType, scopeKind: 'task', scopeId: () => taskId, operationPrefix, value: {} });
}

function taskPath(taskId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}`;
}

function projectPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}
