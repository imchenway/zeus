import { resolve } from 'node:path';
import type { GitDiffSummary, GitStatusSummary } from '@zeus/git-core';
import type { ProjectRepository, ProjectRepositoryRegistrationRepository, ZeusProjectRecord, ZeusProjectRepositoryRecord } from '@zeus/storage';

export interface ProjectGitReadEffectPort {
  /** 读取 workspace 是否具有 Git 元数据；不得创建目录或修复仓库。 */
  workspaceHasGitDirectory(localPath: string): boolean;
  /** 以下端口只允许 Git 读取，不得 fetch、checkout、更新索引或写入 Core DB。 */
  readStatus(localPath: string): Promise<GitStatusSummary>;
  readDiff(localPath: string): Promise<GitDiffSummary>;
  readRepositorySnapshot(localPath: string): Promise<unknown>;
  readCommit(localPath: string, commitHash: string): Promise<unknown>;
  readComparison(localPath: string, ref: string, mode: 'current' | 'working-tree'): Promise<unknown>;
}

interface ProjectGitQueryPorts {
  projects: Pick<ProjectRepository, 'getById'>;
  repositories: Pick<ProjectRepositoryRegistrationRepository, 'listByProject'>;
  effects: ProjectGitReadEffectPort;
  now(): Date;
}

/** Project Git 查询拥有者：只组合已登记仓库与显式只读 Git effect。 */
export class ProjectGitQueryApplication {
  constructor(private readonly ports: ProjectGitQueryPorts) {}

  async readStatus(projectId: string): Promise<GitStatusSummary | (GitStatusSummary & { limitation: string })> {
    const project = this.requireProject(projectId);
    const scope = this.resolveProjectScope(project);
    return 'limitation' in scope ? this.unsupportedStatus(scope.limitation) : this.ports.effects.readStatus(scope.path);
  }

  async readDiff(projectId: string): Promise<GitDiffSummary> {
    const project = this.requireProject(projectId);
    const scope = this.resolveProjectScope(project);
    if ('limitation' in scope) throw queryError('ZEUS_PROJECT_GIT_SCOPE_UNSUPPORTED', scope.limitation, 409);
    return this.ports.effects.readDiff(scope.path);
  }

  async readWorkbench(projectId: string): Promise<{ projectId: string; projectName: string; refreshedAt: string; repositories: Array<Record<string, unknown>> }> {
    const project = this.requireProject(projectId);
    const repositories = this.ports.repositories.listByProject(project.id);
    const items = await mapWithConcurrency(repositories, async (repository) => ({
      id: repository.id,
      name: repository.name,
      relativePath: repository.relativePath,
      localPath: repository.localPath,
      snapshot: await this.ports.effects.readRepositorySnapshot(repository.localPath),
    }));
    return { projectId: project.id, projectName: project.name, refreshedAt: this.ports.now().toISOString(), repositories: items };
  }

  async readCommit(projectId: string, repositoryId: string, commitHash: string): Promise<unknown> {
    const repository = this.requireRepository(this.requireProject(projectId), repositoryId);
    return this.ports.effects.readCommit(repository.localPath, commitHash);
  }

  async readComparison(projectId: string, repositoryId: string, rawRef: string | undefined, rawMode: string | undefined): Promise<unknown> {
    const repository = this.requireRepository(this.requireProject(projectId), repositoryId);
    const ref = rawRef?.trim();
    if (!ref) throw queryError('ZEUS_GIT_REF_REQUIRED', 'A comparison branch is required.');
    return this.ports.effects.readComparison(repository.localPath, ref, rawMode === 'working-tree' ? 'working-tree' : 'current');
  }

  /** 旧项目级 Git 页面没有仓库选择器；多仓配置下必须明确暴露能力边界。 */
  resolveProjectScope(project: ZeusProjectRecord): { path: string } | { limitation: string } {
    const repositories = this.ports.repositories.listByProject(project.id);
    if (repositories.length === 0) {
      if (!this.ports.effects.workspaceHasGitDirectory(project.localPath)) {
        return { limitation: '项目目录不是已登记的 Git 根；如项目包含嵌套仓库，请先在项目设置中确认任务仓库。' };
      }
      return { path: project.localPath };
    }
    if (repositories.length === 1 && resolve(repositories[0]!.localPath) === resolve(project.localPath)) return { path: repositories[0]!.localPath };
    return { limitation: '项目级 Git 页面暂不支持多仓或嵌套仓库；请在任务的代码交付中逐仓操作。' };
  }

  unsupportedStatus(limitation: string): GitStatusSummary & { limitation: string } {
    return {
      isRepository: false,
      branch: '',
      clean: true,
      changedFiles: [],
      conflictFiles: [],
      fileStatuses: [],
      remoteBranches: [],
      recentCommits: [],
      limitation,
    };
  }

  private requireProject(projectId: string): ZeusProjectRecord {
    const project = this.ports.projects.getById(projectId);
    if (!project) throw queryError('ZEUS_PROJECT_NOT_FOUND', 'Project not found', 404);
    return project;
  }

  private requireRepository(project: ZeusProjectRecord, repositoryId: string): ZeusProjectRepositoryRecord {
    const repository = this.ports.repositories.listByProject(project.id).find((candidate) => candidate.id === repositoryId);
    if (!repository) throw queryError('ZEUS_GIT_REPOSITORY_NOT_FOUND', 'The selected repository is no longer part of this project.');
    return repository;
  }
}

async function mapWithConcurrency<Input, Output>(items: Input[], operation: (item: Input, index: number) => Promise<Output>, concurrency = 4): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await operation(items[index]!, index);
      } catch (error) {
        firstError ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

function queryError(code: string, message: string, statusCode?: number): Error & { code: string; statusCode?: number } {
  return Object.assign(new Error(message), { code, ...(statusCode ? { statusCode } : {}) });
}
