import type {GitStatusSummary} from '@zeus/git-core';
import type {ProjectConfigSnapshot} from './projectCore.js';
import type {ProjectRepository, ProjectSharedPathRepository, TaskRepository, ZeusProjectRecord} from '@zeus/storage';

export interface ProjectQueryGitReadEffectPort {
  /** 只读既有 Git 工作区；不得 fetch、修复仓库、更新索引或保存投影。 */
  readOverviewStatus(project: ZeusProjectRecord): Promise<GitStatusSummary & { limitation?: string }>;
}

export interface ProjectGraphSummary {
  nodeCount: number;
  edgeCount: number;
  viewCount: number;
}

interface ProjectQueryPorts {
  projects: Pick<ProjectRepository, 'search' | 'listArchived' | 'getById'>;
  tasks: Pick<TaskRepository, 'listByProject'>;
  sharedPaths: Pick<ProjectSharedPathRepository, 'listByProject'>;
  readConfig(projectId: string): ProjectConfigSnapshot;
  readGraphSummary(project: ZeusProjectRecord): ProjectGraphSummary;
  git: ProjectQueryGitReadEffectPort;
}

/** Project 查询拥有者：聚合复制库投影，并把唯一的 workspace Git 读取暴露为显式 effect port。 */
export class ProjectQueryApplication {
  constructor(private readonly ports: ProjectQueryPorts) {}

  search(query?: string): ZeusProjectRecord[] {
    return this.ports.projects.search({ query });
  }

  listArchived(): ZeusProjectRecord[] {
    return this.ports.projects.listArchived();
  }

  readProject(projectId: string): ZeusProjectRecord {
    return this.requireProject(projectId);
  }

  readConfig(projectId: string): ProjectConfigSnapshot {
    return this.ports.readConfig(this.requireProject(projectId).id);
  }

  readScanStatus(projectId: string): { projectId: string; scanStatus: ZeusProjectRecord['scanStatus']; graph: ProjectGraphSummary } {
    const project = this.requireProject(projectId);
    return {
      projectId: project.id,
      scanStatus: project.scanStatus,
      graph: this.ports.readGraphSummary(project),
    };
  }

  async readOverview(projectId: string): Promise<Record<string, unknown>> {
    const project = this.requireProject(projectId);
    const projectTasks = this.ports.tasks.listByProject(project.id);
    return {
      project,
      graph: this.ports.readGraphSummary(project),
      git: await this.ports.git.readOverviewStatus(project),
      tasks: {
        total: projectTasks.length,
        byStatus: countTasksByStatus(projectTasks),
        recent: projectTasks.slice(-5).reverse(),
      },
    };
  }

  readWorkspaceConfig(projectId: string): Record<string, unknown> {
    const project = this.requireProject(projectId);
    return {
      projectId: project.id,
      containerPath: project.localPath,
      sharedWritablePaths: this.ports.sharedPaths.listByProject(project.id),
    };
  }

  private requireProject(projectId: string): ZeusProjectRecord {
    const project = this.ports.projects.getById(projectId);
    if (!project) throw queryError('ZEUS_PROJECT_NOT_FOUND', 'Project not found', 404);
    return project;
  }
}

function countTasksByStatus(projectTasks: ReturnType<TaskRepository['listByProject']>): Record<string, number> {
  return projectTasks.reduce<Record<string, number>>((counts, task) => {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, {});
}

function queryError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}
