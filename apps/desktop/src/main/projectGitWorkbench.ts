import { withProjectGitAuthentication } from './projectGitAuthentication.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { MainCommandHistoryCursor, MainCommandLedger, MainCommandOutcome } from './mainCommandLedger.js';
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
  type ProjectGitOperationPage,
  type ProjectGitOperationRecord,
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

  /** 仅查询当前可信项目发现的仓库，Renderer 不能直接提交账本作用域或路径。 */
  async loadOperations(projectId: string, cursor: string | undefined, ledger: MainCommandLedger): Promise<ProjectGitOperationPage> {
    /** 项目身份与正常工作台入口共用校验。 */
    const project = await this.requireProject(projectId);
    /** 仓库名称从当前发现结果取得，不信任历史输出内的名称或路径。 */
    const repositories = new Map((await discoverGitRepositories(project.localPath)).map((repository) => [stableRepositoryId(project.id, repository.relativePath), repository.name]));
    /** 游标与项目绑定，禁止拿另一项目的分页位置混合记录。 */
    const position = parseOperationCursor(project.id, cursor);
    /** 账本只读取本页结果，投影之后不把仓库快照传到页面。 */
    const page = await ledger.readHistory({ commandType: 'desktop.project_git.execute_action', scopeKind: 'git_repository', scopeIds: [...repositories.keys()], cursor: position }, (repositoryId, outcome, result) =>
      projectOperationRecord(project.id, repositoryId, repositories.get(repositoryId)!, outcome, result),
    );
    return { ...page, nextCursor: page.nextCursor ? Buffer.from(JSON.stringify([project.id, page.nextCursor.acceptedAt, page.nextCursor.commandId])).toString('base64url') : null };
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

  /** 实际命令由底层执行器逐条回传，历史记录不根据动作名称反推参数。 */
  async execute(
    projectId: string,
    repositoryId: string,
    value: unknown,
    beforeWrite: (repository: DiscoveredGitRepository, action: ProjectGitAction) => Promise<void>,
    signal?: AbortSignal,
    onCommand?: (command: string) => Promise<void>,
  ): Promise<ProjectGitActionResponse> {
    const resolved = await this.resolveRepository(projectId, repositoryId);
    const action = parseProjectGitAction(value);
    const repositoryPath = resolved.repository.localPath;
    if (this.activeRepositories.has(repositoryPath)) throw projectGitError('ZEUS_GIT_BUSY', '该仓库已有 Git 操作正在执行，请等待完成。');
    this.activeRepositories.add(repositoryPath);
    try {
      await beforeWrite(resolved.repository, action);
      signal?.throwIfAborted();
      // 单独推送标签与分支推送共用凭据入口。
      const remoteAction = action.type === 'subtree' || action.type === 'submodule_update' || action.type === 'fetch' || action.type === 'push' || action.type === 'push_tag' || action.type === 'pull' || action.type === 'update';
      const run = (env?: NodeJS.ProcessEnv) => executeProjectGitAction(resolved.repository.localPath, action, signal, env, onCommand);
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

/** 游标只是只读翻页位置，长度、格式及所属项目均须在进入账本前核对。 */
function parseOperationCursor(projectId: string, cursor: string | undefined): MainCommandHistoryCursor | undefined {
  if (cursor === undefined) return undefined;
  if (!cursor || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw projectGitError('ZEUS_GIT_HISTORY_CURSOR_INVALID', '操作记录分页位置无效，请刷新。');
  try {
    /** 不透明游标只包含项目、接纳时间和命令身份。 */
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      value[0] !== projectId ||
      typeof value[1] !== 'string' ||
      !Number.isFinite(Date.parse(value[1])) ||
      typeof value[2] !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value[2])
    )
      throw new Error('invalid cursor');
    return { acceptedAt: value[1], commandId: value[2] };
  } catch {
    throw projectGitError('ZEUS_GIT_HISTORY_CURSOR_INVALID', '操作记录分页位置无效或属于其他项目，请刷新。');
  }
}

/** 每条输出最多展示 64 Ki 字符，账本原文仍按原有保存规则保留。 */
const operationOutputLimit = 64 * 1024;

/** 只从耐久事实投影控制台记录，不能把写出后未知误标为失败。 */
function projectOperationRecord(projectId: string, repositoryId: string, repositoryName: string, outcome: MainCommandOutcome, value: unknown): ProjectGitOperationRecord {
  /** 完整历史结果必须与当前查询身份相符。 */
  const response = isRecord(value) ? value : null;
  if (response && ((response.projectId !== undefined && response.projectId !== projectId) || (response.repositoryId !== undefined && response.repositoryId !== repositoryId)))
    throw projectGitError('ZEUS_GIT_HISTORY_IDENTITY_INVALID', '操作记录身份与当前仓库不符。');
  /** 部分旧记录没有结构化结果，只保留账本已知事实。 */
  const result = response && isRecord(response.result) ? response.result : null;
  /** 未保存动作名称时保留空值，由界面明确说明。 */
  const action = typeof result?.action === 'string' && result.action.trim() ? result.action : null;
  /** 只有结构化结果明确给出成功或冲突，才展示确定的操作结果。 */
  const status: ProjectGitOperationRecord['status'] =
    outcome.state === 'accepted' ? 'running' : outcome.state === 'receipted' ? (result?.outcome === 'completed' || result?.outcome === 'conflict' ? result.outcome : 'recorded') : outcome.state;
  /** 错误摘要已经由账本脱敏；成功输出仍经过 Git 统一脱敏入口。 */
  const output = redactGitOutput(
    result ? [result.stdout, result.stderr, ...(Array.isArray(result.conflictFiles) ? result.conflictFiles : [])].filter((part): part is string => typeof part === 'string' && Boolean(part)).join('\n') : (outcome.failure?.message ?? ''),
  );
  /** 信息缺失和展示截断均可见，不用空输出掩盖。 */
  const limitations: ProjectGitOperationRecord['limitations'] = [];
  if (!action) limitations.push('action_unavailable');
  if (outcome.state === 'receipted' && (!result || (typeof result.stdout !== 'string' && typeof result.stderr !== 'string'))) limitations.push('output_not_saved');
  if (output.length > operationOutputLimit) limitations.push('output_truncated');
  if (!outcome.commandLog) limitations.push('commands_not_saved');
  if (outcome.commandLog?.truncated) limitations.push('commands_truncated');
  return {
    id: outcome.commandId,
    repositoryId,
    repositoryName,
    action,
    startedAt: outcome.acceptedAt,
    durationMs: status === 'running' ? null : Math.max(0, Date.parse(outcome.updatedAt) - Date.parse(outcome.acceptedAt)),
    status,
    // ponytail: 列表输出上限 64 Ki 字符；需要阅读超长全文时再增加独立详情读取，避免分页传输完整快照。
    output: output.slice(0, operationOutputLimit),
    commands: outcome.commandLog?.commands.map(redactGitOutput) ?? null,
    limitations,
  };
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
    case 'apply_patch':
      return { type: 'apply_patch', patch: typeof value.patch === 'string' ? value.patch : '', reverse: value.reverse === true };
    case 'commit':
      return { type: 'commit', message: stringValue('message') ?? '' };
    case 'push':
      return {
        type: 'push',
        remote: stringValue('remote'),
        sourceBranch: stringValue('sourceBranch'),
        targetBranch: stringValue('targetBranch'),
        setUpstream: typeof value.setUpstream === 'boolean' ? value.setUpstream : undefined,
        forceWithLease: value.forceWithLease === true,
        pushTags: value.pushTags === true,
        pushAllTags: value.pushAllTags === true,
      };
    case 'pull': {
      if (value.strategy !== 'rebase' && value.strategy !== 'merge') throw projectGitError('ZEUS_GIT_PULL_STRATEGY_INVALID', '拉取策略必须是 merge 或 rebase。');
      return {
        type: 'pull',
        remote: stringValue('remote'),
        targetBranch: stringValue('targetBranch'),
        strategy: value.strategy,
        commitMerge: value.commitMerge !== false,
        includeMergeLog: value.includeMergeLog === true,
        noFastForward: value.noFastForward === true,
      };
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
    case 'revert':
      return { type: 'revert', revision: stringValue('revision') ?? '' };
    case 'cherry_pick':
      return { type: 'cherry_pick', revision: stringValue('revision') ?? '' };
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
