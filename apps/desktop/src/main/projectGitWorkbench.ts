import { withProjectGitAuthentication } from './projectGitAuthentication.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  discoverGitRepositories,
  executeProjectGitAction,
  getProjectGitCommitDetail,
  getProjectGitHistory,
  getProjectGitComparisonDiff,
  getProjectGitRepositorySnapshot,
  redactGitOutput,
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
  isSubmodule?: boolean;
  subtreePaths?: string[];
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
  private readonly activeRepositories = new Set<string>();
  constructor(private readonly loadProject: (projectId: string) => Promise<ProjectGitProjectIdentity>) {}

  async loadWorkbench(projectId: string): Promise<ProjectGitWorkbenchSnapshot> {
    const project = await this.requireProject(projectId);
    const repositories = await discoverGitRepositories(project.localPath);
    return {
      projectId: project.id,
      projectName: project.name,
      refreshedAt: new Date().toISOString(),
      repositories: await mapWithConcurrency(repositories, async (repository) => ({
        ...(await loadNavigationMetadata(repository.localPath)),
        id: stableRepositoryId(project.id, repository.relativePath),
        name: repository.name,
        relativePath: repository.relativePath,
        snapshot: await getProjectGitRepositorySnapshot(repository.localPath),
      })),
    };
  }

  async loadHistory(projectId: string, repositoryId: string, offset: number, ref?: string) {
    const resolved = await this.resolveRepository(projectId, repositoryId);
    return getProjectGitHistory(resolved.repository.localPath, offset, ref);
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

  async execute(projectId: string, repositoryId: string, value: unknown, beforeWrite: (repository: DiscoveredGitRepository, action: ProjectGitAction) => Promise<void>, signal?: AbortSignal): Promise<ProjectGitActionResponse> {
    const resolved = await this.resolveRepository(projectId, repositoryId);
    const action = parseProjectGitAction(value);
    const repositoryPath = resolved.repository.localPath;
    if (this.activeRepositories.has(repositoryPath)) throw projectGitError('ZEUS_GIT_BUSY', '该仓库已有 Git 操作正在执行，请等待完成。');
    this.activeRepositories.add(repositoryPath);
    try {
      await beforeWrite(resolved.repository, action);
      signal?.throwIfAborted();
      const remoteAction = action.type === 'subtree' || action.type === 'submodule_update' || action.type === 'fetch' || action.type === 'push' || action.type === 'pull' || action.type === 'update';
      const run = (env?: NodeJS.ProcessEnv) => executeProjectGitAction(resolved.repository.localPath, action, signal, env);
      const result = await (remoteAction ? withProjectGitAuthentication(run) : run()).catch((error: unknown) => {
        // 取消也保留底层的恢复信息，尤其是尚未恢复的智能暂存编号。
        const message = redactGitOutput(error instanceof Error ? error.message : String(error));
        if (signal?.aborted) throw projectGitError('ZEUS_GIT_CANCELLED', `Git 操作已中止，请刷新核对仓库状态。已完成的写入不会自动撤销；推送结果需要核对远端。\n${message}`);
        if (/authentication failed|could not read Username|terminal prompts disabled|permission denied.*publickey/iu.test(message)) {
          throw projectGitError('ZEUS_GIT_AUTH_REQUIRED', `Git 鉴权失败。请检查系统凭据管理器、SSH agent 和仓库访问权限后重试。\n${message}`);
        }
        if (/host key verification failed/iu.test(message)) throw projectGitError('ZEUS_GIT_HOST_UNVERIFIED', `SSH 主机验证失败，请核对服务器指纹和 known_hosts 后重试。\n${message}`);
        if (/SIGKILL|ETIMEDOUT/iu.test(message)) throw projectGitError('ZEUS_GIT_TIMEOUT', 'Git 操作超过两分钟，已停止等待。请刷新仓库核对操作结果；推送结果也需要核对远端。');
        throw projectGitError('ZEUS_GIT_ACTION_FAILED', message);
      });
      return {
        projectId: resolved.project.id,
        repositoryId: resolved.id,
        repositoryName: resolved.repository.name,
        result,
        snapshot: await getProjectGitRepositorySnapshot(resolved.repository.localPath),
      };
    } finally {
      this.activeRepositories.delete(repositoryPath);
    }
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
    case 'subtree':
      if (value.operation !== 'add' && value.operation !== 'pull' && value.operation !== 'push') throw projectGitError('ZEUS_GIT_ACTION_INVALID', '不支持的子树操作。');
      return { type: 'subtree', operation: value.operation, path: typeof value.path === 'string' ? value.path : '', remote: stringValue('remote') ?? '', branch: stringValue('branch') ?? '' };
    case 'submodule_update':
      return { type: 'submodule_update', path: typeof value.path === 'string' ? value.path : '' };
    case 'continue_integration':
    case 'abort_integration':
      if (value.kind !== 'merge' && value.kind !== 'rebase') throw projectGitError('ZEUS_GIT_ACTION_INVALID', '恢复动作必须指定合并或变基。');
      return { type: value.type, kind: value.kind };
    case 'fetch':
      return { type: 'fetch', remote: stringValue('remote') };
    case 'discard':
      return { type: 'discard', paths: paths() };
    case 'rename_branch':
      return { type: 'rename_branch', branchName: stringValue('branchName') ?? '', newName: stringValue('newName') ?? '' };
    case 'create_tag':
      return { type: 'create_tag', tagName: stringValue('tagName') ?? '', revision: stringValue('revision') ?? '', message: stringValue('message') };
    case 'push_tag':
      return { type: 'push_tag', tagName: stringValue('tagName') ?? '', remote: stringValue('remote') ?? '' };
    case 'delete_tag':
      return { type: 'delete_tag', tagName: stringValue('tagName') ?? '' };
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
    case 'update': {
      if (value.strategy !== 'merge' && value.strategy !== 'rebase' && value.strategy !== 'reset') throw projectGitError('ZEUS_GIT_UPDATE_STRATEGY_INVALID', '更新策略必须是 merge、rebase 或 reset。');
      return { type: 'update', strategy: value.strategy, smart: value.smart === true };
    }
    case 'checkout':
      return { type: 'checkout', branchName: stringValue('branchName') ?? '', smart: value.smart === true };
    case 'checkout_revision':
      return { type: 'checkout_revision', revision: stringValue('revision') ?? '', smart: value.smart === true };
    case 'create_branch':
      return { type: 'create_branch', branchName: stringValue('branchName') ?? '', baseRef: stringValue('baseRef'), trackRemote: value.trackRemote === true, smart: value.smart === true };
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

// 通过 Git 自身识别子模块关系；子树来自标准 git-subtree 提交标记。
async function loadNavigationMetadata(cwd: string): Promise<{ isSubmodule: boolean; subtreePaths: string[] }> {
  const execute = promisify(execFile);
  const [parent, history] = await Promise.all([
    execute('git', ['rev-parse', '--show-superproject-working-tree'], { cwd, timeout: 10000 }),
    execute('git', ['log', '--all', '--format=%b', '--grep=git-subtree-dir:'], { cwd, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }).catch((error: unknown) => {
      // 新仓库没有提交时，导航仍然可用；其他错误保持可见。
      if (/does not have any commits|bad default revision/iu.test(error instanceof Error ? error.message : '')) return { stdout: '' };
      throw error;
    }),
  ]);
  const subtreePaths = [...new Set([...history.stdout.matchAll(/^git-subtree-dir:\s*(.+)$/gm)].map((match) => match[1]!.trim()).filter((path) => path && !path.startsWith('/') && !path.split('/').includes('..')))];
  return { isSubmodule: Boolean(parent.stdout.trim()), subtreePaths };
}
