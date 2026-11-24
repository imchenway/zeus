import { resolve } from 'node:path';
import type { GitDiffSummary, GitStatusSummary, ProjectGitRepositorySnapshot } from '@zeus/git-core';
import type { ProjectGitPushPreviewInput } from '@zeus/git-core';
import type { GitEnvironmentSummary } from '@zeus/shared';
import type { ProjectRepository, ProjectRepositoryRegistrationRepository, ZeusProjectRecord } from '@zeus/storage';
import { mapWithConcurrency } from './localServerPlatformSupport.js';

export interface ProjectGitReadEffectPort {
  /** 读取 workspace 是否具有 Git 元数据；不得创建目录或修复仓库。 */
  workspaceHasGitDirectory(localPath: string): boolean;
  /** 以下端口只允许 Git 读取，不得 fetch、checkout、更新索引或写入 Core DB。 */
  readStatus(localPath: string): Promise<GitStatusSummary>;
  readDiff(localPath: string): Promise<GitDiffSummary>;
  readRepositorySnapshot(localPath: string, includePatches?: boolean): Promise<unknown>;
  readCommit(localPath: string, commitHash: string): Promise<unknown>;
  /** 只读推送范围，与提交查询保持同一仓库隔离边界。 */
  readPushPreview(localPath: string, input: ProjectGitPushPreviewInput): Promise<unknown>;
  readHistory(localPath: string, offset: number, ref?: string): Promise<unknown>;
  readComparison(localPath: string, ref: string, mode: 'current' | 'working-tree' | 'staged' | 'unstaged', path?: string, summaryOnly?: boolean, targetCommit?: string): Promise<unknown>;
}

interface ProjectGitQueryPorts {
  projects: Pick<ProjectRepository, 'getById'>;
  repositories: Pick<ProjectRepositoryRegistrationRepository, 'listByProject'>;
  effects: ProjectGitReadEffectPort;
  now(): Date;
  /** 会话工作区可能包含多个仓库，查询列表保留完整成员。 */
  resolveConversationWorkspace(
    project: ZeusProjectRecord,
    conversationId: string,
  ): Promise<{ repositories: Array<{ id: string; name: string; relativePath: string; localPath: string }>; sourceBranches?: GitEnvironmentSummary['sourceBranches']; unavailableRepositories?: string[] }>;
  resolveConversationRepository(project: ZeusProjectRecord, conversationId: string): Promise<{ id: string; name: string; relativePath: string; localPath: string }>;
  /** 回收历史仅供交付读视图使用，来源路径不作为会话执行位置。 */
  resolveRecoveredConversationRepositories(
    project: ZeusProjectRecord,
    key: { conversationId: string } | { repositoryKey: string },
  ): Promise<Array<{ id: string; name: string; relativePath: string; localPath: string; branchName: string; headSha: string; sourceHeadSha: string | null }>>;
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

  async readWorkbench(
    projectId: string,
    conversationId?: string,
    includePatches = true,
  ): Promise<{ projectId: string; projectName: string; refreshedAt: string; committedOnly?: true; unavailableRepositories?: string[]; repositories: Array<Record<string, unknown>> }> {
    const project = this.requireProject(projectId);
    const header = { projectId: project.id, projectName: project.name };
    /** 会话来源与环境卡片复用同一份已核验记录。 */
    let workspace: Awaited<ReturnType<ProjectGitQueryPorts['resolveConversationWorkspace']>> | null = null;
    if (conversationId) {
      try {
        workspace = await this.ports.resolveConversationWorkspace(project, conversationId);
      } catch (error) {
        if (!isConversationWorktreeUnavailable(error)) throw error;
        const recovered = await this.ports.resolveRecoveredConversationRepositories(project, { conversationId });
        if (!recovered.length) throw error;
        const repositories = recovered.map(({ id, name, relativePath, branchName, headSha, sourceHeadSha }) => ({
          id,
          name,
          relativePath,
          snapshot: committedOnlySnapshot(branchName, headSha, sourceHeadSha),
        }));
        return { ...header, refreshedAt: this.ports.now().toISOString(), committedOnly: true, repositories };
      }
    }
    const repositories = workspace?.repositories ?? this.ports.repositories.listByProject(project.id);
    const items = await mapWithConcurrency(repositories, async (repository) => ({
      id: repository.id,
      name: repository.name,
      relativePath: repository.relativePath,
      localPath: repository.localPath,
      sourceBranch: workspace?.sourceBranches?.find((source) => source.repositoryRelativePath === repository.relativePath)?.branch ?? null,
      snapshot: await this.ports.effects.readRepositorySnapshot(repository.localPath, includePatches),
    }));
    return { ...header, refreshedAt: this.ports.now().toISOString(), repositories: items, ...(workspace?.unavailableRepositories?.length ? { unavailableRepositories: workspace.unavailableRepositories } : {}) };
  }

  async readCommit(projectId: string, repositoryId: string, commitHash: string): Promise<unknown> {
    const repository = await this.requireRepository(this.requireProject(projectId), repositoryId);
    return this.ports.effects.readCommit(repository.localPath, commitHash);
  }

  /** 会话工作树和已登记项目仓库均由既有解析器确定路径。 */
  async readPushPreview(projectId: string, repositoryId: string, input: ProjectGitPushPreviewInput): Promise<unknown> {
    /** 不允许 HTTP 请求指定磁盘路径。 */
    const repository = await this.requireRepository(this.requireProject(projectId), repositoryId);
    return this.ports.effects.readPushPreview(repository.localPath, input);
  }

  async readComparison(projectId: string, repositoryId: string, rawRef: string | undefined, rawMode: string | undefined, path?: string, summaryOnly = false): Promise<unknown> {
    const project = this.requireProject(projectId);
    const ref = rawRef?.trim();
    if (!ref) throw queryError('ZEUS_GIT_REF_REQUIRED', 'A comparison branch is required.');
    const mode = rawMode ?? 'current';
    if (mode !== 'current' && mode !== 'working-tree' && mode !== 'staged' && mode !== 'unstaged') throw queryError('ZEUS_GIT_COMPARISON_MODE_INVALID', 'Git 比较范围无效。');
    let repository;
    try {
      repository = await this.requireRepository(project, repositoryId);
    } catch (error) {
      if (mode !== 'current' || !repositoryId.startsWith('conversation:') || !isConversationWorktreeUnavailable(error)) throw error;
      const [recovered] = await this.ports.resolveRecoveredConversationRepositories(project, { repositoryKey: repositoryId.slice('conversation:'.length) });
      if (!recovered) throw error;
      /** 清单和单文件比较由同一回收记录提供两端提交。 */
      const base = recovered.sourceHeadSha;
      if (!base || ref !== base) throw queryError('ZEUS_GIT_REF_REQUIRED', '无法确认已提交成果的比较基线。', 409);
      return this.ports.effects.readComparison(recovered.localPath, base, 'current', path, summaryOnly, recovered.headSha);
    }
    return this.ports.effects.readComparison(repository.localPath, ref, mode, path, summaryOnly);
  }

  async readHistory(projectId: string, repositoryId: string, offset: number, ref?: string) {
    const repository = await this.requireRepository(this.requireProject(projectId), repositoryId);
    if (!Number.isSafeInteger(offset) || offset < 0) throw queryError('ZEUS_GIT_OFFSET_INVALID', '历史分页位置无效。');
    return this.ports.effects.readHistory(repository.localPath, offset, ref);
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

  private async requireRepository(project: ZeusProjectRecord, repositoryId: string) {
    if (repositoryId.startsWith('conversation:')) return this.ports.resolveConversationRepository(project, repositoryId.slice('conversation:'.length));
    const repository = this.ports.repositories.listByProject(project.id).find((candidate) => candidate.id === repositoryId);
    if (!repository) throw queryError('ZEUS_GIT_REPOSITORY_NOT_FOUND', 'The selected repository is no longer part of this project.');
    return repository;
  }
}

/** 只有工作树不可用时才尝试读取回收记录。 */
function isConversationWorktreeUnavailable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ZEUS_CONVERSATION_WORKTREE_UNAVAILABLE';
}

/** 回收结果只展示持久提交；工作树、分支动作和暂存字段没有数据。 */
function committedOnlySnapshot(branch: string, headSha: string, sourceHeadSha: string | null): ProjectGitRepositorySnapshot {
  const emptyDiff: GitDiffSummary = { isRepository: true, files: [], diffText: '', fileDiffs: [] };
  return {
    branch,
    headSha,
    sourceHeadSha,
    detached: !branch,
    clean: true,
    ahead: 0,
    behind: 0,
    upstream: null,
    headTags: [],
    fileStatuses: [],
    conflictFiles: [],
    localBranches: [],
    checkedOutBranches: [],
    remoteBranches: [],
    remotes: [],
    tags: [],
    recentRefs: [],
    recentCommits: [],
    outgoingCommits: [],
    stashes: [],
    diff: emptyDiff,
    stagedDiff: emptyDiff,
    unstagedDiff: emptyDiff,
  };
}

function queryError(code: string, message: string, statusCode?: number): Error & { code: string; statusCode?: number } {
  return Object.assign(new Error(message), { code, ...(statusCode ? { statusCode } : {}) });
}
