import type { FilePreviewIntent, FilePreviewRequest } from '@zeus/shared';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MainCommandHistoryCursor, MainCommandLedger, MainCommandOutcome } from './mainCommandLedger.js';
import {
  discoverGitRepositories,
  discoverGitRepositoryRoots,
  projectGitRepositoryId,
  executeProjectGitAction,
  withGitRepositoryOperation,
  getProjectGitCommitDetail,
  getProjectGitPushPreview,
  type ProjectGitPushPreviewInput,
  getGitFilePreviewSources,
  getProjectGitBranchComparison,
  getProjectGitHistory,
  getProjectGitLogInfo,
  getProjectGitComparisonDiff,
  getProjectGitBranchSnapshot,
  getProjectGitRepositorySnapshot,
  redactGitOutput,
  type DiscoveredGitRepository,
  type GitDiffSummary,
  type ProjectGitAction,
  type ProjectGitActionResult,
  type ProjectGitCommandObserver,
  type ProjectGitBranchComparisonQuery,
  type ProjectGitComparisonPageQuery,
  type ProjectGitHistoryAction,
  type ProjectGitLogRead,
  type ProjectGitBranchSelection,
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
  /** Native Checkout can report a confirmed refusal without losing the recorded command. */
  result: Omit<ProjectGitActionResult, 'outcome'> & { outcome: ProjectGitActionResult['outcome'] | 'blocked' };
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

  /** 打开窗口只核对归属，不提前生成窗口随后还会读取的完整快照。 */
  async validateDeliveryScope(projectId: string, repositoryId?: string): Promise<void> {
    if (repositoryId !== undefined) await this.resolveRepository(projectId, repositoryId);
    else await this.requireProject(projectId);
  }

  /** 文件列表读取可跳过补丁，完整工作台仍保留原有快照。 */
  async loadWorkbench(projectId: string, includePatches = true): Promise<ProjectGitWorkbenchSnapshot> {
    const project = await this.requireProject(projectId);
    const repositories = await discoverGitRepositories(project.localPath);
    return {
      projectId: project.id,
      projectName: project.name,
      refreshedAt: new Date().toISOString(),
      repositories: await mapWithConcurrency(repositories, async (repository) => {
        /** 导航元数据与工作区状态互不依赖，在既有并发上限内一起读取。 */
        const [navigation, snapshot] = await Promise.all([loadNavigationMetadata(repository.localPath), getProjectGitRepositorySnapshot(repository.localPath, includePatches, repository.context)]);
        return { ...navigation, id: projectGitRepositoryId(project.id, repository.relativePath), name: repository.name, relativePath: repository.relativePath, snapshot };
      }),
    };
  }

  /** 会话只读取分支选择所需的元数据，仓库范围沿用工作台发现规则。 */
  async loadBranches(projectId: string, includeReferences: boolean): Promise<ProjectGitBranchSelection> {
    const project = await this.requireProject(projectId);
    const repositories = await discoverGitRepositoryRoots(project.localPath);
    return {
      projectId: project.id,
      repositories: await mapWithConcurrency(repositories, async (repository) => ({
        id: projectGitRepositoryId(project.id, repository.relativePath),
        name: repository.name,
        relativePath: repository.relativePath,
        snapshot: await getProjectGitBranchSnapshot(repository.localPath, includeReferences),
      })),
    };
  }

  async loadHistory(projectId: string, repositoryId: string, offset: number, ref?: string, filters?: unknown) {
    const resolved = await this.resolveRepository(projectId, repositoryId);
    return getProjectGitHistory(resolved.repository.localPath, offset, ref, filters === undefined ? undefined : parseGitHistoryFilters(filters));
  }

  /** Log 工具只读取项目内仓库，刷新和筛选不写工作区。 */
  async loadLogInfo(projectId: string, repositoryId: string, value: unknown) {
    if (
      !isRecord(value) ||
      typeof value.kind !== 'string' ||
      !['authors', 'identity', 'tree', 'history_paths', 'message', 'patch', 'rebase', 'shelf', 'update', 'resolve', 'cherry', 'children'].includes(value.kind) ||
      ['ref', 'before'].some((key) => value[key] !== undefined && !validText(value[key])) ||
      (value.offset !== undefined && typeof value.offset !== 'number')
    )
      throw projectGitError('ZEUS_GIT_LOG_REQUEST', 'Invalid Git Log request.');
    const resolved = await this.resolveRepository(projectId, repositoryId);
    return getProjectGitLogInfo(resolved.repository.localPath, value as unknown as ProjectGitLogRead);
  }

  /** 双向历史只读取项目内已发现仓库，查询条件不作为 Git 参数直接透传。 */
  async loadBranchComparison(projectId: string, repositoryId: string, value: unknown) {
    const query = parseBranchComparisonQuery(value);
    const resolved = await this.resolveRepository(projectId, repositoryId);
    return getProjectGitBranchComparison(resolved.repository.localPath, query);
  }

  /** 仅查询当前可信项目发现的仓库，Renderer 不能直接提交账本作用域或路径。 */
  async loadOperations(projectId: string, cursor: string | undefined, ledger: MainCommandLedger): Promise<ProjectGitOperationPage> {
    /** 项目身份与正常工作台入口共用校验。 */
    const project = await this.requireProject(projectId);
    /** 仓库名称从当前发现结果取得，不信任历史输出内的名称或路径。 */
    const repositories = new Map((await discoverGitRepositories(project.localPath)).map((repository) => [projectGitRepositoryId(project.id, repository.relativePath), repository.name]));
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

  /** 复用项目发现的仓库身份，预览不接受 Renderer 指定的本机路径。 */
  async loadPushPreview(projectId: string, repositoryId: string, input: ProjectGitPushPreviewInput) {
    /** 只查询当前项目实际拥有的仓库。 */
    const resolved = await this.resolveRepository(projectId, repositoryId);
    return getProjectGitPushPreview(resolved.repository.localPath, input);
  }

  async loadComparison(projectId: string, repositoryId: string, ref: string, mode: 'current' | 'working-tree' | 'staged' | 'unstaged', path?: string, summaryOnly = false): Promise<GitDiffSummary> {
    const resolved = await this.resolveRepository(projectId, repositoryId);
    if (!ref.trim()) throw projectGitError('ZEUS_GIT_REF_REQUIRED', '必须选择一个比较分支。');
    return getProjectGitComparisonDiff(resolved.repository.localPath, ref, mode, path, summaryOnly);
  }

  /** 桌面仓库身份由自身发现服务校验，不与宿主数据库的登记 ID 混用。 */
  async loadFilePreview(input: Extract<FilePreviewRequest, { kind: 'project-git' }>): Promise<FilePreviewIntent> {
    for (const [key, value] of Object.entries(input)) {
      if (key !== 'revisions' && value !== undefined && !validText(value)) throw new Error('Git 预览参数无效。');
    }
    if (input.revisions !== undefined && (!Array.isArray(input.revisions) || input.revisions.length !== 2 || input.revisions.some((value) => typeof value !== 'string' || !/^[a-f0-9]{40,64}$/u.test(value)))) {
      throw new Error('Select two Git commits to preview.');
    }
    if (input.stage && !['combined', 'staged', 'unstaged'].includes(input.stage)) throw new Error('Git 预览范围无效。');
    if (input.comparisonMode && !['current', 'working-tree'].includes(input.comparisonMode)) throw new Error('Git 比较范围无效。');
    const resolved = await this.resolveRepository(input.projectId, input.repositoryId);
    return { sides: await getGitFilePreviewSources(resolved.repository.localPath, input) };
  }

  /** 实际命令由底层执行器逐条回传，历史记录不根据动作名称反推参数。 */
  async execute(
    projectId: string,
    repositoryId: string,
    value: unknown,
    beforeWrite: (repository: DiscoveredGitRepository, action: ProjectGitAction) => Promise<void>,
    signal?: AbortSignal,
    onCommand?: ProjectGitCommandObserver,
  ): Promise<ProjectGitActionResponse> {
    const resolved = await this.resolveRepository(projectId, repositoryId);
    const action = parseProjectGitAction(value);
    const repositoryPath = resolved.repository.localPath;
    if (this.activeRepositories.has(repositoryPath)) throw projectGitError('ZEUS_GIT_BUSY', '该仓库已有 Git 操作正在执行，请等待完成。');
    this.activeRepositories.add(repositoryPath);
    try {
      // 锁竞争必须发生在耐久写标记之前；底层 Git 执行器复用同一锁的可重入所有权。
      return await withGitRepositoryOperation(repositoryPath, async () => {
        await beforeWrite(resolved.repository, action);
        signal?.throwIfAborted();
        // 桌面、Core 和模型子进程继承同一系统认证入口，不为每次操作创建临时提示程序。
        /** 只有 Git 明确保护性拒绝且 HEAD 与当前分支仍一致时，才返回可继续的 Checkout。 */
        const checkout = action.type === 'checkout' || action.type === 'checkout_revision' || (action.type === 'create_branch' && action.checkout !== false);
        const result = await executeProjectGitAction(repositoryPath, action, signal, undefined, onCommand).catch((error: unknown) => {
          if (!checkout || signal?.aborted || !isRecord(error) || error.code !== 'ZEUS_GIT_CHECKOUT_BLOCKED') throw error;
          return { error };
        });
        const snapshot = await getProjectGitRepositorySnapshot(repositoryPath);
        if ('error' in result) {
          const before = resolved.repository.context;
          if (snapshot.headSha !== before.headSha || snapshot.branch !== before.branch || snapshot.detached !== before.detached || snapshot.conflictFiles.length) throw result.error;
          return {
            projectId: resolved.project.id,
            repositoryId: resolved.id,
            repositoryName: resolved.repository.name,
            snapshot,
            result: {
              action: action.type,
              outcome: 'blocked',
              branch: snapshot.branch,
              headSha: snapshot.headSha,
              conflictFiles: [],
              stdout: '',
              stderr: typeof result.error.details === 'string' ? redactGitOutput(result.error.details) : '',
            },
          };
        }
        return {
          projectId: resolved.project.id,
          repositoryId: resolved.id,
          repositoryName: resolved.repository.name,
          result,
          snapshot,
        };
      });
    } catch (error: unknown) {
      // 取消也保留底层的恢复信息，尤其是尚未恢复的智能暂存编号。
      const message = redactGitOutput(error instanceof Error ? error.message : String(error));
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
      const details = isRecord(error) && typeof error.details === 'string' ? error.details : undefined;
      if (signal?.aborted) throw projectGitError('ZEUS_GIT_CANCELLED', `Git 操作已中止，请刷新核对仓库状态。已完成的写入不会自动撤销；推送结果需要核对远端。\n${message}`);
      if (/authentication failed|could not read Username|terminal prompts disabled|permission denied.*publickey/iu.test(message)) {
        throw projectGitError('ZEUS_GIT_AUTH_REQUIRED', `Git 鉴权失败。请检查系统凭据管理器、SSH agent 和仓库访问权限后重试。\n${message}`);
      }
      if (/host key verification failed/iu.test(message)) throw projectGitError('ZEUS_GIT_HOST_UNVERIFIED', `SSH 主机验证失败，请核对服务器指纹和 known_hosts 后重试。\n${message}`);
      if (/SIGKILL|ETIMEDOUT/iu.test(message)) throw projectGitError('ZEUS_GIT_TIMEOUT', 'Git 操作超过两分钟，已停止等待。请刷新仓库核对操作结果；推送结果也需要核对远端。');
      // Git Core 已经识别出的可处理原因不能再次降级成通用失败，否则界面会丢失具体提示。
      if (code.startsWith('ZEUS_GIT_') && code !== 'ZEUS_GIT_COMMAND_FAILED') throw projectGitError(code, message, details);
      throw projectGitError('ZEUS_GIT_ACTION_FAILED', message, details);
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
    const repository = repositories.find((candidate) => projectGitRepositoryId(project.id, candidate.relativePath) === normalizedRepositoryId);
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
  const paused = result?.outcome === 'completed' && response && isRecord(response.snapshot) && response.snapshot.integrationState === 'rebase' && ['history_edit', 'continue_integration', 'rebase', 'checkout_rebase'].includes(action ?? '');
  const status: ProjectGitOperationRecord['status'] =
    outcome.state === 'accepted'
      ? 'running'
      : outcome.state === 'receipted'
        ? paused
          ? 'paused'
          : result?.outcome === 'completed' || result?.outcome === 'conflict' || result?.outcome === 'blocked'
            ? result.outcome
            : 'recorded'
        : outcome.state;
  /** 错误摘要已经由账本脱敏；成功输出仍经过 Git 统一脱敏入口。 */
  const output = redactGitOutput(
    result ? [result.stdout, result.stderr, ...(Array.isArray(result.conflictFiles) ? result.conflictFiles : [])].filter((part): part is string => typeof part === 'string' && Boolean(part)).join('\n') : (outcome.failure?.message ?? ''),
  );
  /** 信息缺失和展示截断均可见，不用空输出掩盖。 */
  const limitations: ProjectGitOperationRecord['limitations'] = [];
  if (!action) limitations.push('action_unavailable');
  const commandDetails = outcome.commandLog?.details;
  if (!commandDetails && outcome.state === 'receipted' && (!result || (typeof result.stdout !== 'string' && typeof result.stderr !== 'string'))) limitations.push('output_not_saved');
  if (commandDetails?.some((entry) => entry?.truncated) || (!commandDetails && output.length > operationOutputLimit)) limitations.push('output_truncated');
  if (!outcome.commandLog) limitations.push('commands_not_saved');
  if (outcome.commandLog?.truncated) limitations.push('commands_truncated');
  return {
    id: outcome.commandId,
    repositoryId,
    repositoryName,
    action,
    startedAt: outcome.acceptedAt,
    updatedAt: outcome.updatedAt,
    durationMs: status === 'running' ? null : Math.max(0, Date.parse(outcome.updatedAt) - Date.parse(outcome.acceptedAt)),
    status,
    // ponytail: 列表输出上限 64 Ki 字符；需要阅读超长全文时再增加独立详情读取，避免分页传输完整快照。
    output: output.slice(0, operationOutputLimit),
    stdout: typeof result?.stdout === 'string' ? redactGitOutput(result.stdout).slice(0, operationOutputLimit) : undefined,
    stderr: typeof result?.stderr === 'string' ? redactGitOutput(result.stderr).slice(0, operationOutputLimit) : undefined,
    commands: outcome.commandLog?.commands.map(redactGitOutput) ?? null,
    commandDetails,
    limitations,
  };
}

/** 比较范围和过滤器由桌面入口校验，日期只接受日历选择值。 */
function parseBranchComparisonQuery(value: unknown): ProjectGitBranchComparisonQuery {
  if (!isRecord(value) || !validText(value.branchRef) || !validText(value.headRef) || (!value.branch && !value.head)) {
    throw projectGitError('ZEUS_GIT_COMPARE_INVALID', 'Select a branch and HEAD to compare.');
  }
  return { branchRef: value.branchRef, headRef: value.headRef, branch: value.branch === undefined ? undefined : parseGitHistoryFilters(value.branch), head: value.head === undefined ? undefined : parseGitHistoryFilters(value.head) };
}

/** 普通 Log 与分支比较使用同一套结构化过滤条件。 */
function parseGitHistoryFilters(page: unknown): ProjectGitComparisonPageQuery {
  if (
    !isRecord(page) ||
    (page.offset !== undefined && typeof page.offset !== 'number') ||
    ['text', 'author'].some((key) => page[key] !== undefined && !validText(page[key])) ||
    (page.paths !== undefined && (Array.isArray(page.paths) ? !page.paths.every(validText) : !validText(page.paths))) ||
    ['regex', 'matchCase', 'me', 'firstParent', 'noMerges', 'follow'].some((key) => page[key] !== undefined && typeof page[key] !== 'boolean') ||
    (page.authors !== undefined && (!Array.isArray(page.authors) || page.authors.length > 100 || page.authors.some((email) => !validText(email)))) ||
    (page.sort !== undefined && page.sort !== 'date' && page.sort !== 'topo') ||
    ['since', 'until'].some((key) => page[key] !== undefined && (typeof page[key] !== 'string' || page[key].length > 35 || !Number.isFinite(Date.parse(page[key]))))
  ) {
    throw projectGitError('ZEUS_GIT_COMPARE_FILTER_INVALID', 'Invalid Git Log filters.');
  }
  return page as ProjectGitComparisonPageQuery;
}

/** 限制查询字段的传输大小，并拒绝无法传给 Git 的空字节。 */
function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && !value.includes('\0');
}

/** 解析桌面动作白名单，并保留用户确认的目标快照供共享 Git 层核验。 */
function parseProjectGitAction(value: unknown): ProjectGitAction {
  if (!isRecord(value) || typeof value.type !== 'string') throw projectGitError('ZEUS_GIT_ACTION_INVALID', '必须选择受支持的 Git 动作。');
  const stringValue = (key: string): string | undefined => (typeof value[key] === 'string' ? value[key].trim() || undefined : undefined);
  const paths = (): string[] => {
    const candidate = value.paths;
    if (!Array.isArray(candidate) || candidate.some((path) => typeof path !== 'string')) throw projectGitError('ZEUS_GIT_PATH_INVALID', 'Git 路径必须是字符串数组。');
    return candidate;
  };
  switch (value.type) {
    case 'history_edit': {
      const operation = value.operation;
      if (
        typeof operation !== 'string' ||
        !['reset', 'undo', 'message', 'fixup', 'squash', 'drop', 'interactive', 'push', 'revert_file', 'amend_rebase'].includes(operation) ||
        ['revision', 'expectedBranch', 'expectedHeadSha', 'mode', 'message', 'remote', 'targetBranch', 'path'].some((key) => value[key] !== undefined && !validText(value[key])) ||
        (value.paths !== undefined && (!Array.isArray(value.paths) || !value.paths.length || !value.paths.every(validText))) ||
        (value.plan !== undefined &&
          (!Array.isArray(value.plan) ||
            value.plan.some(
              (entry) =>
                !isRecord(entry) ||
                typeof entry.revision !== 'string' ||
                !/^[a-f0-9]{40,64}$/u.test(entry.revision) ||
                typeof entry.action !== 'string' ||
                !['pick', 'edit', 'reword', 'squash', 'fixup', 'drop'].includes(entry.action) ||
                (entry.action === 'reword' && !validText(entry.message)),
            )))
      ) {
        throw projectGitError('ZEUS_GIT_HISTORY_ACTION_INVALID', 'Invalid Git history action.');
      }
      return value as unknown as ProjectGitHistoryAction;
    }
    case 'shelve':
      return { type: 'shelve', message: stringValue('message') ?? '', paths: value.paths === undefined ? undefined : paths() };
    case 'unshelve':
      return { type: 'unshelve', shelfRef: stringValue('shelfRef') ?? '', revision: stringValue('revision') ?? '', paths: value.paths === undefined ? undefined : paths(), remove: value.remove === true };
    case 'delete_shelf':
      return { type: value.type, shelfRef: stringValue('shelfRef') ?? '', revision: stringValue('revision') ?? '' };
    case 'subtree':
      if (value.operation !== 'add' && value.operation !== 'pull' && value.operation !== 'push') throw projectGitError('ZEUS_GIT_ACTION_INVALID', '不支持的子树操作。');
      return { type: 'subtree', operation: value.operation, path: typeof value.path === 'string' ? value.path : '', remote: stringValue('remote') ?? '', branch: stringValue('branch') ?? '' };
    case 'submodule_update':
      return { type: 'submodule_update', path: typeof value.path === 'string' ? value.path : '' };
    case 'continue_integration':
    case 'skip_integration':
    case 'abort_integration':
      if (value.kind !== 'merge' && value.kind !== 'rebase' && value.kind !== 'cherry-pick' && value.kind !== 'revert') throw projectGitError('ZEUS_GIT_ACTION_INVALID', 'Select a valid Git operation.');
      return { type: value.type, kind: value.kind };
    case 'fetch':
      return { type: 'fetch', remote: stringValue('remote') };
    case 'rollback':
    case 'discard':
      return { type: value.type, paths: paths() };
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
      return {
        type: 'apply_patch',
        patch: typeof value.patch === 'string' ? value.patch : '',
        reverse: value.reverse === true,
        target: value.target === 'worktree' ? 'worktree' : 'index',
      };
    case 'commit':
      return {
        type: 'commit',
        message: stringValue('message') ?? '',
        ...(value.paths === undefined ? {} : { paths: paths() }),
        expectedHeadSha: typeof value.expectedHeadSha === 'string' ? value.expectedHeadSha : undefined,
        expectedBranch: stringValue('expectedBranch'),
      };
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
    case 'update_branch':
      if (value.strategy !== 'merge' && value.strategy !== 'rebase') throw projectGitError('ZEUS_GIT_UPDATE_STRATEGY_INVALID', 'Select Merge or Rebase.');
      return { type: 'update_branch', branchName: stringValue('branchName') ?? '', strategy: value.strategy };
    case 'checkout':
      return { type: 'checkout', branchName: stringValue('branchName') ?? '', smart: value.smart === true };
    case 'checkout_rebase':
      return { type: 'checkout_rebase', branchName: stringValue('branchName') ?? '', baseRef: stringValue('baseRef'), expectedBranch: stringValue('expectedBranch') ?? '', expectedHeadSha: stringValue('expectedHeadSha') ?? '' };
    case 'checkout_revision':
      return { type: 'checkout_revision', revision: stringValue('revision') ?? '', smart: value.smart === true };
    case 'create_branch':
      return { type: 'create_branch', branchName: stringValue('branchName') ?? '', baseRef: stringValue('baseRef'), trackRemote: value.trackRemote === true, smart: value.smart === true, checkout: value.checkout !== false };
    case 'delete_branch':
      return { type: 'delete_branch', branchName: stringValue('branchName') ?? '' };
    case 'revert':
      return { type: 'revert', revision: stringValue('revision') ?? '' };
    case 'cherry_pick':
      return { type: 'cherry_pick', revision: stringValue('revision') ?? '' };
    case 'merge':
      return { type: 'merge', branchName: stringValue('branchName') ?? '', expectedBranch: stringValue('expectedBranch') ?? '', expectedHeadSha: stringValue('expectedHeadSha') ?? '' };
    case 'rebase':
      return { type: 'rebase', branchName: stringValue('branchName') ?? '', expectedBranch: stringValue('expectedBranch'), expectedHeadSha: stringValue('expectedHeadSha') };
    case 'stash':
      return { type: 'stash', message: stringValue('message'), includeUntracked: value.includeUntracked === true, keepIndex: value.keepIndex === true };
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

/** 消息同时保留错误身份，读取入口与结构化命令入口显示相同原因。 */
function projectGitError(code: string, message: string, details?: string): Error & { code: string; details?: string } {
  return Object.assign(new Error(message.startsWith(`${code}:`) ? message : `${code}: ${message}`), { code, ...(details ? { details } : {}) });
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
