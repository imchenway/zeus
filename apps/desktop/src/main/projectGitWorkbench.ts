import { createHash } from 'node:crypto';
import {
  discoverGitRepositories,
  executeProjectGitAction,
  getProjectGitCommitDetail,
  getProjectGitComparisonDiff,
  getProjectGitRepositorySnapshot,
  type DiscoveredGitRepository,
  type GitDiffSummary,
  type ProjectGitAction,
  type ProjectGitActionResult,
  type ProjectGitCommitDetail,
  type ProjectGitRepositorySnapshot,
} from '@zeus/git-core';

export interface ProjectGitProjectIdentity {
  id: string;
  name: string;
  localPath: string;
}

export interface ProjectGitRepositoryWorkbenchItem {
  id: string;
  name: string;
  relativePath: string;
  snapshot: ProjectGitRepositorySnapshot;
}

export interface ProjectGitWorkbenchSnapshot {
  projectId: string;
  projectName: string;
  refreshedAt: string;
  repositories: ProjectGitRepositoryWorkbenchItem[];
}

export interface ProjectGitActionResponse {
  projectId: string;
  repositoryId: string;
  repositoryName: string;
  result: ProjectGitActionResult;
  snapshot: ProjectGitRepositorySnapshot;
}

interface ResolvedProjectGitRepository {
  id: string;
  project: ProjectGitProjectIdentity;
  repository: DiscoveredGitRepository;
}

/**
 * 项目 Git 工作台跟随当前 App 版本运行，不依附可能跨版本排空的任务执行宿主。
 * 所有请求都从受信项目身份重新发现仓库，Renderer 提供的仓库 ID 不能直接变成本机路径。
 */
export class ProjectGitWorkbenchService {
  constructor(private readonly loadProject: (projectId: string) => Promise<ProjectGitProjectIdentity>) {}

  async loadWorkbench(projectId: string): Promise<ProjectGitWorkbenchSnapshot> {
    const project = await this.requireProject(projectId);
    const repositories = await discoverGitRepositories(project.localPath);
    return {
      projectId: project.id,
      projectName: project.name,
      refreshedAt: new Date().toISOString(),
      repositories: await mapWithConcurrency(repositories, async (repository) => ({
        id: stableRepositoryId(project.id, repository.relativePath),
        name: repository.name,
        relativePath: repository.relativePath,
        snapshot: await getProjectGitRepositorySnapshot(repository.localPath),
      })),
    };
  }

  async loadCommit(projectId: string, repositoryId: string, commitHash: string): Promise<ProjectGitCommitDetail> {
    const resolved = await this.resolveRepository(projectId, repositoryId);
    if (!commitHash.trim()) throw projectGitError('ZEUS_GIT_COMMIT_REQUIRED', '必须选择一个提交。');
    return getProjectGitCommitDetail(resolved.repository.localPath, commitHash);
  }

  async loadComparison(projectId: string, repositoryId: string, ref: string, mode: 'current' | 'working-tree'): Promise<GitDiffSummary> {
    const resolved = await this.resolveRepository(projectId, repositoryId);
    if (!ref.trim()) throw projectGitError('ZEUS_GIT_REF_REQUIRED', '必须选择一个比较分支。');
    return getProjectGitComparisonDiff(resolved.repository.localPath, ref, mode);
  }

  async execute(projectId: string, repositoryId: string, value: unknown): Promise<ProjectGitActionResponse> {
    const resolved = await this.resolveRepository(projectId, repositoryId);
    const action = parseProjectGitAction(value);
    const result = await executeProjectGitAction(resolved.repository.localPath, action);
    return {
      projectId: resolved.project.id,
      repositoryId: resolved.id,
      repositoryName: resolved.repository.name,
      result,
      snapshot: await getProjectGitRepositorySnapshot(resolved.repository.localPath),
    };
  }

  private async requireProject(projectId: string): Promise<ProjectGitProjectIdentity> {
    const normalized = projectId.trim();
    if (!normalized) throw projectGitError('ZEUS_PROJECT_ID_REQUIRED', '项目身份不能为空。');
    const project = await this.loadProject(normalized);
    if (project.id !== normalized || !project.name.trim() || !project.localPath.trim()) {
      throw projectGitError('ZEUS_PROJECT_NOT_FOUND', '项目不存在或项目目录不可用。');
    }
    return project;
  }

  private async resolveRepository(projectId: string, repositoryId: string): Promise<ResolvedProjectGitRepository> {
    const project = await this.requireProject(projectId);
    const normalizedRepositoryId = repositoryId.trim();
    if (!normalizedRepositoryId) throw projectGitError('ZEUS_GIT_REPOSITORY_REQUIRED', '必须选择一个项目仓库。');
    const repositories = await discoverGitRepositories(project.localPath);
    const repository = repositories.find((candidate) => stableRepositoryId(project.id, candidate.relativePath) === normalizedRepositoryId);
    if (!repository) throw projectGitError('ZEUS_GIT_REPOSITORY_NOT_FOUND', '所选仓库已不属于当前项目，请刷新 Git 工作台。');
    return { id: normalizedRepositoryId, project, repository };
  }
}

function stableRepositoryId(projectId: string, relativePath: string): string {
  return `project_git_repository_${createHash('sha256').update(`${projectId}\0${relativePath}`).digest('hex').slice(0, 24)}`;
}

function parseProjectGitAction(value: unknown): ProjectGitAction {
  if (!isRecord(value) || typeof value.type !== 'string') throw projectGitError('ZEUS_GIT_ACTION_INVALID', '必须选择受支持的 Git 动作。');
  const stringValue = (key: string): string | undefined => (typeof value[key] === 'string' ? value[key].trim() || undefined : undefined);
  const paths = (): string[] => {
    const candidate = value.paths;
    if (!Array.isArray(candidate) || candidate.some((path) => typeof path !== 'string')) throw projectGitError('ZEUS_GIT_PATH_INVALID', 'Git 路径必须是字符串数组。');
    return candidate;
  };
  switch (value.type) {
    case 'fetch':
      return { type: 'fetch', remote: stringValue('remote') };
    case 'stage':
      return { type: 'stage', paths: paths() };
    case 'unstage':
      return { type: 'unstage', paths: paths() };
    case 'commit':
      return { type: 'commit', message: stringValue('message') ?? '' };
    case 'push':
      return { type: 'push', remote: stringValue('remote'), targetBranch: stringValue('targetBranch'), forceWithLease: value.forceWithLease === true, pushTags: value.pushTags === true };
    case 'pull': {
      if (value.strategy !== 'rebase' && value.strategy !== 'merge') throw projectGitError('ZEUS_GIT_PULL_STRATEGY_INVALID', '拉取策略必须是 merge 或 rebase。');
      return { type: 'pull', remote: stringValue('remote'), targetBranch: stringValue('targetBranch'), strategy: value.strategy };
    }
    case 'checkout':
      return { type: 'checkout', branchName: stringValue('branchName') ?? '' };
    case 'create_branch':
      return { type: 'create_branch', branchName: stringValue('branchName') ?? '', baseRef: stringValue('baseRef'), trackRemote: value.trackRemote === true };
    case 'delete_branch':
      return { type: 'delete_branch', branchName: stringValue('branchName') ?? '' };
    case 'merge':
      return { type: 'merge', branchName: stringValue('branchName') ?? '' };
    case 'rebase':
      return { type: 'rebase', branchName: stringValue('branchName') ?? '' };
    case 'stash':
      return { type: 'stash', message: stringValue('message'), includeUntracked: value.includeUntracked === true };
    case 'apply_stash':
      return { type: 'apply_stash', stashRef: stringValue('stashRef') ?? '', pop: value.pop === true };
    case 'drop_stash':
      return { type: 'drop_stash', stashRef: stringValue('stashRef') ?? '' };
    default:
      throw projectGitError('ZEUS_GIT_ACTION_UNSUPPORTED', `不支持的项目 Git 动作：${value.type}`);
  }
}

async function mapWithConcurrency<Input, Output>(items: Input[], operation: (item: Input) => Promise<Output>, concurrency = 4): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await operation(items[index]!);
      } catch (error) {
        firstError = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectGitError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
