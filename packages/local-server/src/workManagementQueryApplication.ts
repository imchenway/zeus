import type { TaskStatus } from '@zeus/shared';
import type { ProjectRepository, TaskBoardRepository, TaskEventRepository, TaskManagementStatus, TaskRepository, TaskTemplateRepository, ZeusTaskRecord } from '@zeus/storage';

export interface ListWorkManagementTasksQuery {
  projectId?: string;
  query?: string;
  status?: TaskStatus;
  managementStatus?: TaskManagementStatus;
  tag?: string;
  sortBy?: 'createdAt' | 'updatedAt' | 'title' | 'taskType' | 'status' | 'managementStatus';
  sortDirection?: 'asc' | 'desc';
}

interface WorkManagementQueryPorts {
  projects: Pick<ProjectRepository, 'getById'>;
  tasks: Pick<TaskRepository, 'getById' | 'listByProject' | 'listArchivedByProject'>;
  taskBoards: Pick<TaskBoardRepository, 'getSnapshot'>;
  taskEvents: Pick<TaskEventRepository, 'listByTask'>;
  taskTemplates: Pick<TaskTemplateRepository, 'listForProject' | 'listAll'>;
}

/** Work Management 查询拥有者：只读取 Core DB，不解析 Git、Provider 或 workspace 现场。 */
export class WorkManagementQueryApplication {
  constructor(private readonly ports: WorkManagementQueryPorts) {}

  readTask(taskId: string): ZeusTaskRecord {
    const task = this.ports.tasks.getById(taskId);
    if (!task) throw queryError('ZEUS_TASK_NOT_FOUND', 'Task not found', 404);
    return task;
  }

  readTaskBoard(projectId: string): ReturnType<TaskBoardRepository['getSnapshot']> {
    if (!this.ports.projects.getById(projectId)) throw queryError('ZEUS_PROJECT_NOT_FOUND', 'Project not found', 404);
    return this.ports.taskBoards.getSnapshot(projectId);
  }

  listTaskEvents(taskId: string): ReturnType<TaskEventRepository['listByTask']> {
    // 保持历史兼容：未知 taskId 返回空时间线，而不是新增 404。
    return this.ports.taskEvents.listByTask(taskId);
  }

  listTasks(query: ListWorkManagementTasksQuery): ZeusTaskRecord[] {
    const projectId = query.projectId;
    if (!projectId) throw queryError('ZEUS_PROJECT_REQUIRED', 'projectId is required', 400);
    return this.ports.tasks.listByProject(projectId, {
      query: query.query,
      status: query.status,
      managementStatus: query.managementStatus,
      tag: query.tag,
      sortBy: query.sortBy,
      sortDirection: query.sortDirection,
    });
  }

  listArchivedTasks(projectId?: string): ZeusTaskRecord[] {
    if (!projectId) throw queryError('ZEUS_PROJECT_REQUIRED', 'projectId is required', 400);
    return this.ports.tasks.listArchivedByProject(projectId);
  }

  listTaskTemplates(projectId?: string): ReturnType<TaskTemplateRepository['listAll']> {
    return projectId ? this.ports.taskTemplates.listForProject(projectId) : this.ports.taskTemplates.listAll();
  }
}

function queryError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}
