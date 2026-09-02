import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Git Core 对外暴露的真实 mutation capability 单一来源。
 *
 * 上层机器清单按这里的名字动态发现调用点；新增 Git 写能力若未进入该表，或进入该表后
 * 没有在独立内部副作用清单中取得精确恢复边界，架构门禁都会失败关闭。
 */
export const gitMutatingCapabilityNames = [
  'prepareTaskWorktree',
  'cleanupPreparedTaskWorktree',
  'refreshConflictTaskWorkspace',
  'fetchGitRemote',
  'commitTaskWorkspace',
  'pushTaskWorkspace',
  'pushLocalBranch',
  'reclaimTaskWorktree',
  'reclaimDeliveredTaskWorktree',
  'removeTaskWorktreeForTerminalStatus',
  'discardTaskWorktree',
  'startTaskBranchIntegration',
  'startTaskIntegrationAttempt',
  'writeTaskIntegrationResolution',
  'writeTaskIntegrationDraft',
  'completeTaskIntegrationCommit',
  'finalizeTaskBranchIntegration',
  'cleanupTaskIntegrationWorktree',
  'executeHighRiskGitOperation',
  'executeProjectGitAction',
] as const;

export interface GitStatusSummary {
  isRepository: boolean;
  branch: string;
  clean: boolean;
  changedFiles: string[];
  conflictFiles: string[];
  fileStatuses: GitFileStatus[];
  remoteBranches: string[];
  recentCommits: GitRecentCommit[];
}

export interface GitWorkingContext {
  isRepository: boolean;
  branch: string | null;
}

export interface GitWorktreeEntry {
  path: string;
  headSha: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface GitRepositoryContext {
  isRepository: boolean;
  topLevel: string;
  branch: string;
  detached: boolean;
  headSha: string;
  localBranches: string[];
  remoteBranches: string[];
  remotes: string[];
  worktrees: GitWorktreeEntry[];
}

export interface DiscoveredGitRepository {
  name: string;
  relativePath: string;
  localPath: string;
  branch: string;
  headSha: string;
  clean: boolean;
  localBranches: string[];
  remotes: string[];
  context: GitRepositoryContext;
}

export interface PrepareTaskWorktreeInput {
  repositoryPath: string;
  repositoryContext?: GitRepositoryContext;
  projectSlug: string;
  taskCode: string;
  taskTitle: string;
  workspaceId: string;
  branchName: string;
  sourceRef: string;
  sourceKind?: 'local' | 'remote';
  sourceBranch?: string;
  existingBranch: boolean;
  existingRemoteRef?: string;
  worktreePath?: string;
  includeLocalChanges?: boolean;
  ignoredPaths?: string[];
}

export interface PreparedTaskWorktree {
  topLevel: string;
  worktreePath: string;
  branchName: string;
  sourceBranch: string;
  sourceHeadSha: string;
  headSha: string;
  reused: boolean;
  localChangesApplied: boolean;
}

export interface TaskWorkspaceReview {
  cwd: string;
  branch: string;
  headSha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  conflictFiles: string[];
  stagedFiles: GitFileStatus[];
  unstagedFiles: GitFileStatus[];
  untrackedFiles: GitFileStatus[];
  stagedDiff: GitDiffSummary;
  unstagedDiff: GitDiffSummary;
}

export interface CommitTaskWorkspaceInput {
  cwd: string;
  message: string;
  selectedPaths: string[];
  ignoredPaths?: string[];
}

export interface CommitTaskWorkspaceResult {
  branch: string;
  headSha: string;
  committed: boolean;
  formattedPaths: string[];
}

export interface PushTaskWorkspaceInput {
  cwd: string;
  ignoredPaths?: string[];
  remoteName?: string;
  remoteBranch?: string;
}

export interface PushTaskWorkspaceResult {
  branch: string;
  headSha: string;
  remoteName: string;
  remoteBranch: string;
  remoteHeadSha: string;
}

export interface PushLocalBranchInput {
  repositoryPath: string;
  remoteName: string;
  branchName: string;
}

export interface TaskWorkspaceFileDiff {
  path: string;
  diff: GitDiffSummary;
}

export interface TaskBranchFileChange {
  path: string;
  originalPath?: string;
  changeType: GitDiffFileChangeType;
  additions: number;
  deletions: number;
}

export interface TaskBranchComparison {
  sourceBranch: string;
  taskBranch: string;
  sourceHeadSha: string;
  taskHeadSha: string;
  mergeBaseSha: string;
  ahead: number;
  behind: number;
  files: TaskBranchFileChange[];
}

export interface TaskBranchIntegrationStartResult {
  integrationPath: string;
  targetBranch: string;
  targetHeadSha: string;
  taskBranch: string;
  taskHeadSha: string;
  mode: 'merge' | 'squash';
  state: 'ready' | 'conflicted';
  resultHeadSha: string | null;
  conflictFiles: string[];
}

export interface TaskIntegrationConflictFile {
  path: string;
  fingerprint: string;
  base: string;
  source: string;
  task: string;
  result: string;
}

export interface FinalizedTaskBranchIntegration {
  targetBranch: string;
  targetHeadSha: string;
  resultHeadSha: string;
  remoteName: string;
  remoteHeadSha: string | null;
  localSyncStatus: 'synced' | 'pending';
  localHeadSha: string;
  localWorktreePath: string | null;
}

export type GitFileStatusCategory = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict' | 'other';

export interface GitFileStatus {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workingTreeStatus: string;
  category: GitFileStatusCategory;
}

export interface GitRecentCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authoredAt: string;
  parentHashes: string[];
}

export interface ProjectGitStashEntry {
  ref: string;
  hash: string;
  subject: string;
  author: string;
  authoredAt: string;
}

export interface ProjectGitRecentRef {
  ref: string;
  kind: 'local' | 'remote' | 'tag' | 'revision';
}

export interface ProjectGitRepositorySnapshot {
  branch: string;
  detached: boolean;
  headTags: string[];
  headSha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  fileStatuses: GitFileStatus[];
  conflictFiles: string[];
  localBranches: string[];
  checkedOutBranches: string[];
  remoteBranches: string[];
  remotes: string[];
  tags: string[];
  recentRefs: ProjectGitRecentRef[];
  recentCommits: GitRecentCommit[];
  outgoingCommits: GitRecentCommit[];
  stashes: ProjectGitStashEntry[];
  diff: GitDiffSummary;
  stagedDiff: GitDiffSummary;
  unstagedDiff: GitDiffSummary;
}

export type ProjectGitAction =
  | { type: 'fetch'; remote?: string }
  | { type: 'stage'; paths: string[] }
  | { type: 'unstage'; paths: string[] }
  | { type: 'commit'; message: string }
  | { type: 'push'; remote?: string; targetBranch?: string; forceWithLease?: boolean; pushTags?: boolean }
  | { type: 'pull'; remote?: string; targetBranch?: string; strategy: 'rebase' | 'merge' }
  | { type: 'update'; strategy: 'merge' | 'rebase' | 'reset'; smart?: boolean }
  | { type: 'checkout'; branchName: string; smart?: boolean }
  | { type: 'checkout_revision'; revision: string; smart?: boolean }
  | { type: 'create_branch'; branchName: string; baseRef?: string; trackRemote?: boolean; smart?: boolean }
  | { type: 'delete_branch'; branchName: string }
  | { type: 'merge'; branchName: string }
  | { type: 'rebase'; branchName: string }
  | { type: 'stash'; message?: string; includeUntracked?: boolean }
  | { type: 'apply_stash'; stashRef: string; pop?: boolean }
  | { type: 'drop_stash'; stashRef: string };

export interface ProjectGitActionResult extends GitRunnerResult {
  action: ProjectGitAction['type'];
  outcome: 'completed' | 'conflict';
  branch: string;
  headSha: string;
  conflictFiles: string[];
}

export interface ProjectGitCommitDetail {
  commit: GitRecentCommit;
  body: string;
  parentHashes: string[];
  files: Array<{ path: string; additions: number; deletions: number }>;
  diff: GitDiffSummary;
}

export interface GitDiffSummary {
  isRepository: boolean;
  files: string[];
  diffText: string;
  fileDiffs: GitFileDiff[];
}

export type GitDiffFileChangeType = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
export type GitDiffLineType = 'context' | 'addition' | 'deletion' | 'metadata';

export interface GitDiffLine {
  type: GitDiffLineType;
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface GitDiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: GitDiffLine[];
}

export interface GitFileDiff {
  oldPath: string;
  newPath: string;
  changeType: GitDiffFileChangeType;
  addedLines: number;
  deletedLines: number;
  hunks: GitDiffHunk[];
}

export interface GitPatchExport {
  fileName: string;
  mimeType: 'text/x-patch';
  patchText: string;
  files: string[];
  createdAt: string;
}

/** 读取仓库、分支和 worktree 身份；该快照不修改 refs 或工作区。 */
export async function getGitRepositoryContext(cwd: string): Promise<GitRepositoryContext> {
  try {
    const topLevel = await requireGitStdout(cwd, ['rev-parse', '--show-toplevel']);
    const [rawBranch, headSha, rawLocalBranches, rawRemoteBranches, rawRemotes, rawWorktrees] = await Promise.all([
      requireGitStdout(topLevel, ['branch', '--show-current']),
      requireGitStdout(topLevel, ['rev-parse', 'HEAD']),
      readGitStdout(topLevel, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      readGitStdout(topLevel, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
      readGitStdout(topLevel, ['remote']),
      requireGitStdout(topLevel, ['worktree', 'list', '--porcelain']),
    ]);
    const detached = rawBranch.length === 0;
    const branch = rawBranch || 'detached';
    const localBranches = splitLines(rawLocalBranches);
    const remoteBranches = splitLines(rawRemoteBranches).filter((ref) => !ref.endsWith('/HEAD'));
    const remotes = splitLines(rawRemotes);
    const worktrees = parseGitWorktreeList(rawWorktrees);
    return { isRepository: true, topLevel, branch, detached, headSha, localBranches, remoteBranches, remotes, worktrees };
  } catch {
    return { isRepository: false, topLevel: '', branch: '', detached: false, headSha: '', localBranches: [], remoteBranches: [], remotes: [], worktrees: [] };
  }
}

/**
 * 在项目容器内发现真实 Git 根目录；只返回候选，不替用户登记仓库。
 * 扫描跳过依赖、构建产物和 Zeus 自己的 worktree 根，避免把缓存仓库误纳入项目。
 */
export async function discoverGitRepositories(containerPath: string, maxDepth = 6): Promise<DiscoveredGitRepository[]> {
  const containerRoot = canonicalFilesystemPath(containerPath);
  const candidates: string[] = [];
  const seen = new Set<string>();
  const skippedDirectories = new Set(['.git', '.tmp', '.zeus-worktrees', 'node_modules', 'dist', 'build', 'target', '.next', '.turbo', '.cache']);

  let currentLevel = [containerRoot];
  for (let depth = 0; depth <= maxDepth && currentLevel.length > 0; depth += 1) {
    const nested = await mapWithConcurrency(currentLevel, 8, async (directoryPath) => {
      try {
        const [gitMarker, entries] = await Promise.all([lstat(join(directoryPath, '.git')).catch(() => null), readdir(directoryPath, { withFileTypes: true })]);
        if (gitMarker?.isDirectory() || gitMarker?.isFile()) {
          const repositoryRoot = canonicalFilesystemPath(directoryPath);
          if (!seen.has(repositoryRoot)) {
            seen.add(repositoryRoot);
            candidates.push(repositoryRoot);
          }
        }
        if (depth === maxDepth) return [];
        return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !skippedDirectories.has(entry.name)).map((entry) => join(directoryPath, entry.name));
      } catch {
        // 单个无权限或消失目录不应让整个候选扫描失败。
        return [];
      }
    });
    currentLevel = nested.flat();
  }
  const discovered = await mapWithConcurrency(candidates, 4, async (localPath) => {
    const [context, clean] = await Promise.all([getGitRepositoryContext(localPath), getGitWorktreeClean(localPath)]);
    if (!context.isRepository || canonicalFilesystemPath(context.topLevel) !== localPath) return null;
    const repositoryRelativePath = relative(containerRoot, localPath);
    if (repositoryRelativePath === '..' || repositoryRelativePath.startsWith(`..${sep}`) || isAbsolute(repositoryRelativePath)) return null;
    return {
      name: basename(localPath),
      relativePath: repositoryRelativePath ? repositoryRelativePath.split(sep).join('/') : '.',
      localPath,
      branch: context.branch,
      headSha: context.headSha,
      clean,
      localBranches: context.localBranches,
      remotes: context.remotes,
      context,
    } satisfies DiscoveredGitRepository;
  });
  return discovered.filter((candidate): candidate is DiscoveredGitRepository => candidate !== null).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function mapWithConcurrency<Input, Output>(items: Input[], concurrency: number, operation: (item: Input, index: number) => Promise<Output>): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()));
  return results;
}

/** 为一次任务推送生成共同根目录；逐仓 worktree 会按原相对路径放在该根目录内。 */
export function buildTaskEnvironmentRootPath(projectContainerPath: string, projectSlug: string, taskCode: string, pushId: string): string {
  const containerRoot = resolve(projectContainerPath);
  const root = join(dirname(containerRoot), '.zeus-worktrees');
  const safeProject = safePathSegment(projectSlug || basename(containerRoot));
  const safeTask = safePathSegment(taskCode);
  const safePush = safePathSegment(pushId).slice(-20) || 'push';
  return join(root, safeProject, safePush, safeTask);
}

/** 从任务编码、名称和开发线序号生成可读分支；最终合法性仍由 git check-ref-format 判定。 */
export function buildTaskBranchName(taskCode: string, taskTitle: string, sequence: number): string {
  const slug =
    taskTitle
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 36) || 'task';
  return `${buildTaskBranchPrefix(taskCode)}${slug}-${String(Math.max(1, Math.trunc(sequence))).padStart(2, '0')}`;
}

/** 用任务编码限定可接管的既有本地任务分支，避免把其他任务分支登记到当前任务。 */
export function buildTaskBranchPrefix(taskCode: string): string {
  const normalizedCode =
    taskCode
      .trim()
      .replace(/[^A-Za-z0-9._-]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'TASK';
  return `zeus/${normalizedCode}-`;
}

/** 使用 Git 自己的规则校验分支名，避免复制一份会漂移的手写正则。 */
export async function assertValidGitBranchName(cwd: string, branchName: string): Promise<string> {
  const normalized = branchName.trim();
  if (!normalized.startsWith('zeus/')) throw gitCoreError('ZEUS_TASK_BRANCH_PREFIX_REQUIRED', 'Task branches must use the zeus/ prefix.');
  try {
    return await assertGitBranchFormat(cwd, normalized, 'task branch');
  } catch {
    throw gitCoreError('ZEUS_TASK_BRANCH_INVALID', `Invalid task branch name: ${normalized}`);
  }
}

/**
 * 创建或恢复任务 worktree。已注册的同名分支 worktree 会直接复用，
 * 从而保证一个任务开发分支同时只有一个物理写工作区。
 */
export async function prepareTaskWorktree(input: PrepareTaskWorktreeInput): Promise<PreparedTaskWorktree> {
  const context = input.repositoryContext ?? (await getGitRepositoryContext(input.repositoryPath));
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The selected project is not a Git repository.');
  const branchName = await assertValidGitBranchName(context.topLevel, input.branchName);
  // 新建工作区按调用方选中的本机可用引用冻结精确提交；恢复只接受持久化对象 ID。
  const adoptLocalBranch = input.existingBranch && input.sourceKind === 'local';
  const sourceRef = input.existingBranch && !adoptLocalBranch ? requireGitObjectId(input.sourceRef, 'source commit') : input.sourceRef.trim();
  const sourceBranch = adoptLocalBranch
    ? await assertNamedBranchExists(context.topLevel, sourceRef, 'task branch')
    : input.existingBranch
      ? input.sourceBranch?.trim() || sourceRef
      : input.sourceKind === 'remote'
        ? await assertRemoteBranchExists(context.topLevel, sourceRef, input.sourceBranch)
        : await assertNamedBranchExists(context.topLevel, sourceRef, 'source branch');
  const sourceHeadSha = await resolveCommit(context.topLevel, input.existingBranch && !adoptLocalBranch ? sourceRef : input.sourceKind === 'remote' ? `refs/remotes/${sourceRef}` : localBranchRef(sourceRef));
  const registered = context.worktrees.find((entry) => entry.branch === branchName);
  if (registered) {
    if (!input.existingBranch) {
      throw gitCoreError('ZEUS_TASK_BRANCH_ALREADY_EXISTS', `Task branch already has a registered worktree: ${branchName}`);
    }
    const headSha = await resolveCommit(registered.path, 'HEAD');
    return {
      topLevel: context.topLevel,
      worktreePath: registered.path,
      branchName,
      sourceBranch,
      sourceHeadSha,
      headSha,
      reused: true,
      localChangesApplied: false,
    };
  }

  const worktreePath = input.worktreePath ? resolve(input.worktreePath) : buildTaskWorktreePath(context.topLevel, input.projectSlug, input.taskCode, input.workspaceId);
  await mkdir(dirname(worktreePath), { recursive: true });
  const localBranchExists = context.localBranches.includes(branchName);
  if (localBranchExists && !input.existingBranch) {
    throw gitCoreError('ZEUS_TASK_BRANCH_ALREADY_EXISTS', `Task branch already exists locally: ${branchName}`);
  }
  try {
    if (input.existingBranch) {
      if (localBranchExists) {
        await runGit(context.topLevel, ['worktree', 'add', worktreePath, branchName]);
      } else {
        const remoteRef = input.existingRemoteRef?.trim() ?? '';
        if (!remoteRef || !context.remoteBranches.includes(remoteRef)) {
          throw gitCoreError('ZEUS_TASK_BRANCH_NOT_FOUND', `Existing task branch is not available locally or on its recorded remote: ${branchName}`);
        }
        await runGit(context.topLevel, ['worktree', 'add', '-b', branchName, worktreePath, remoteRef]);
      }
    } else {
      await runGit(context.topLevel, ['worktree', 'add', '-b', branchName, worktreePath, sourceHeadSha]);
    }
    const localChangesApplied = input.includeLocalChanges === true && !input.existingBranch ? await applyLocalChangesToTaskWorktree(context.topLevel, worktreePath, input.ignoredPaths) : false;
    const headSha = await resolveCommit(worktreePath, 'HEAD');
    return {
      topLevel: context.topLevel,
      worktreePath,
      branchName,
      sourceBranch,
      sourceHeadSha,
      headSha,
      reused: false,
      localChangesApplied,
    };
  } catch (error) {
    await cleanupPreparedTaskWorktree({ repositoryPath: context.topLevel, worktreePath, branchName, removeBranch: !input.existingBranch }).catch(() => undefined);
    throw error;
  }
}

/**
 * 与 Codex 托管 worktree 一致，把来源工作目录的 staged、unstaged、未跟踪文件和
 * `.worktreeinclude` 命中的忽略文件应用到新任务工作区。任一步失败都会由调用方回收。
 */
async function applyLocalChangesToTaskWorktree(sourcePath: string, targetPath: string, ignoredPaths: string[] = []): Promise<boolean> {
  const ignored = ignoredPaths.map((path) => requireSafeWorkspacePath(path));
  const pathspec = ['.', ...ignored.flatMap((path) => [`:(exclude)${path}`, `:(exclude)${path}/**`])];
  const stagedPatch = await readGitDiffAllowChanges(sourcePath, ['diff', '--cached', '--binary', '--', ...pathspec]);
  const unstagedPatch = await readGitDiffAllowChanges(sourcePath, ['diff', '--binary', '--', ...pathspec]);
  const untracked = splitNullRecords((await runGit(sourcePath, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspec])).stdout);
  const includeFile = join(sourcePath, '.worktreeinclude');
  const includeExists = await lstat(includeFile)
    .then((entry) => entry.isFile())
    .catch(() => false);
  const includedIgnored = includeExists ? splitNullRecords((await runGit(sourcePath, ['ls-files', '--others', '--ignored', `--exclude-from=${includeFile}`, '-z', '--', ...pathspec])).stdout) : [];
  const copyPaths = Array.from(new Set([...untracked, ...includedIgnored]));
  const hasChanges = Boolean(stagedPatch || unstagedPatch || copyPaths.length > 0);
  if (!hasChanges) return false;

  const patchRoot = dirname(targetPath);
  if (stagedPatch) {
    const patchPath = join(patchRoot, `.zeus-staged-${process.pid}-${Date.now()}.patch`);
    await writeFile(patchPath, stagedPatch, 'utf8');
    try {
      await runGit(targetPath, ['apply', '--index', '--binary', patchPath]);
    } finally {
      await rm(patchPath, { force: true });
    }
  }
  if (unstagedPatch) {
    const patchPath = join(patchRoot, `.zeus-unstaged-${process.pid}-${Date.now()}.patch`);
    await writeFile(patchPath, unstagedPatch, 'utf8');
    try {
      await runGit(targetPath, ['apply', '--binary', patchPath]);
    } finally {
      await rm(patchPath, { force: true });
    }
  }
  for (const relativePath of copyPaths) {
    const safePath = requireSafeWorkspacePath(relativePath);
    const sourceFile = resolve(sourcePath, safePath);
    const targetFile = resolve(targetPath, safePath);
    if (!isPathInside(sourcePath, sourceFile) || !isPathInside(targetPath, targetFile)) throw gitCoreError('ZEUS_GIT_PATH_INVALID', `Local change path escapes its repository: ${relativePath}`);
    const sourceEntry = await lstat(sourceFile);
    if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink()) continue;
    const targetEntry = await lstat(targetFile).catch(() => null);
    if (targetEntry) throw gitCoreError('ZEUS_TASK_LOCAL_CHANGE_CONFLICT', `Local untracked file conflicts with the selected source branch: ${relativePath}`);
    await mkdir(dirname(targetFile), { recursive: true });
    await copyFile(sourceFile, targetFile);
  }
  return true;
}

/** 精确回收本次刚创建的任务 worktree；只在创建失败回滚或用户显式回收时调用。 */
export async function cleanupPreparedTaskWorktree(input: { repositoryPath: string; worktreePath: string; branchName: string; removeBranch: boolean }): Promise<void> {
  const context = await getGitRepositoryContext(input.repositoryPath);
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'Task workspace repository is unavailable during cleanup.');
  const targetPath = canonicalFilesystemPath(input.worktreePath);
  const registered = context.worktrees.find((entry) => canonicalFilesystemPath(entry.path) === targetPath);
  if (registered) await runGit(context.topLevel, ['worktree', 'remove', '--force', registered.path]);
  else await rm(input.worktreePath, { recursive: true, force: true });
  if (input.removeBranch && context.localBranches.includes(input.branchName)) await runGit(context.topLevel, ['branch', '-D', input.branchName]);
}

/** 汇总 IDEA 式提交窗口所需的 staged、unstaged、untracked 与冲突状态。 */
export async function getTaskWorkspaceReview(cwd: string, ignoredPaths: string[] = [], repositoryContext?: GitRepositoryContext): Promise<TaskWorkspaceReview> {
  const context = repositoryContext ?? (await getGitRepositoryContext(cwd));
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'Task workspace is not a Git repository.');
  const ignored = ignoredPaths.map((path) => requireSafeWorkspacePath(path));
  const isIgnored = (path: string): boolean => ignored.some((ignoredPath) => path === ignoredPath || path.startsWith(`${ignoredPath}/`));
  const diffPathspec = ['.', ...ignored.flatMap((path) => [`:(exclude)${path}`, `:(exclude)${path}/**`])];
  // Porcelain 的前两列包含有意义的空格，不能经过通用 splitLines 的 trim。
  const porcelainPromise = runGit(cwd, ['status', '--porcelain=v1', '-z', '-uall', '--', ...diffPathspec]).then((result) => result.stdout);
  const upstreamPromise = readGitStdout(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).then((value) => value || null);
  const unstagedStatPromise = runGit(cwd, ['diff', '--numstat', '-z', '--', ...diffPathspec]).then((result) => result.stdout);
  const stagedStatPromise = runGit(cwd, ['diff', '--cached', '--numstat', '-z', '--', ...diffPathspec]).then((result) => result.stdout);
  const [porcelain, upstream, unstagedStat, stagedStat] = await Promise.all([porcelainPromise, upstreamPromise, unstagedStatPromise, stagedStatPromise]);
  const fileStatuses = parseGitPorcelainEntries(porcelain).filter((file) => !isIgnored(file.path) && (!file.originalPath || !isIgnored(file.originalPath)));
  const counts = upstream ? parseAheadBehind(await readGitStdout(cwd, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])) : { ahead: 0, behind: 0 };
  const stagedFiles = fileStatuses.filter((file) => file.indexStatus !== ' ' && file.indexStatus !== '?');
  const unstagedFiles = fileStatuses.filter((file) => file.workingTreeStatus !== ' ' && file.workingTreeStatus !== '?');
  const untrackedFiles = fileStatuses.filter((file) => file.indexStatus === '?' && file.workingTreeStatus === '?');
  return {
    cwd: resolve(cwd),
    branch: context.branch,
    headSha: context.headSha,
    upstream,
    ...counts,
    clean: fileStatuses.length === 0,
    conflictFiles: fileStatuses.filter((file) => file.category === 'conflict').map((file) => file.path),
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    stagedDiff: gitDiffStatSummary(stagedStat, stagedFiles),
    unstagedDiff: gitDiffStatSummary(unstagedStat, unstagedFiles),
  };
}

/** 只读取工作区是否干净，避免为能力列表生成完整差异。 */
export async function getGitWorktreeClean(cwd: string, ignoredPaths: string[] = []): Promise<boolean> {
  const ignored = ignoredPaths.map((path) => requireSafeWorkspacePath(path));
  const pathspec = ['.', ...ignored.flatMap((path) => [`:(exclude)${path}`, `:(exclude)${path}/**`])];
  return (await runGit(cwd, ['status', '--porcelain=v1', '-z', '-uall', '--', ...pathspec])).stdout.length === 0;
}

function gitDiffStatSummary(stdout: string, statuses: GitFileStatus[]): GitDiffSummary {
  const statusByPath = new Map(statuses.map((status) => [status.path, status]));
  const fileDiffs = parseGitNumStat(stdout).map((entry): GitFileDiff => {
    const status = statusByPath.get(entry.path);
    const changeType: GitDiffFileChangeType = status?.category === 'added' || status?.category === 'deleted' || status?.category === 'renamed' ? status.category : 'modified';
    const originalPath = entry.originalPath ?? status?.originalPath;
    return {
      oldPath: changeType === 'added' ? '' : (originalPath ?? entry.path),
      newPath: changeType === 'deleted' ? '' : entry.path,
      changeType,
      addedLines: entry.additions,
      deletedLines: entry.deletions,
      hunks: [],
    };
  });
  return { isRepository: true, files: fileDiffs.map((file) => file.newPath || file.oldPath), diffText: '', fileDiffs };
}

function parseGitNumStat(stdout: string): Array<{ path: string; originalPath?: string; additions: number; deletions: number }> {
  const records = stdout.split('\0');
  const entries: Array<{ path: string; originalPath?: string; additions: number; deletions: number }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (!record) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = firstTab >= 0 ? record.indexOf('\t', firstTab + 1) : -1;
    if (firstTab < 0 || secondTab < 0) continue;
    const additions = Number.parseInt(record.slice(0, firstTab), 10);
    const deletions = Number.parseInt(record.slice(firstTab + 1, secondTab), 10);
    const inlinePath = record.slice(secondTab + 1);
    if (inlinePath) {
      entries.push({ path: inlinePath, additions: Number.isFinite(additions) ? additions : 0, deletions: Number.isFinite(deletions) ? deletions : 0 });
      continue;
    }
    const originalPath = records[++index] ?? '';
    const path = records[++index] ?? originalPath;
    if (path) entries.push({ path, ...(originalPath && originalPath !== path ? { originalPath } : {}), additions: Number.isFinite(additions) ? additions : 0, deletions: Number.isFinite(deletions) ? deletions : 0 });
  }
  return entries;
}

/** 读取提交窗口当前文件的 HEAD 对比；未跟踪文件以 /dev/null 为旧版本。 */
export async function getTaskWorkspaceFileDiff(cwd: string, path: string): Promise<TaskWorkspaceFileDiff> {
  const safePath = requireSafeWorkspacePath(path);
  const review = await getTaskWorkspaceReview(cwd);
  const untracked = review.untrackedFiles.some((file) => file.path === safePath);
  const diffText = untracked ? await readGitDiffAllowChanges(cwd, ['diff', '--no-index', '--binary', '--', '/dev/null', safePath]) : await readGitDiffAllowChanges(cwd, ['diff', 'HEAD', '--binary', '--', safePath]);
  return { path: safePath, diff: diffSummaryFromText(diffText) };
}

/** 读取任务分支相对来源分支共同起点产生的已提交代码成果。 */
export async function getTaskBranchComparison(repositoryPath: string, sourceBranch: string, taskBranch: string, frozenSourceHeadSha?: string, repositoryContext?: GitRepositoryContext): Promise<TaskBranchComparison> {
  const context = repositoryContext ?? (await getGitRepositoryContext(repositoryPath));
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The selected project is not a Git repository.');
  const [safeSourceBranch, safeTaskBranch] = await Promise.all([assertGitBranchFormat(context.topLevel, sourceBranch, 'source branch'), assertNamedBranchExists(context.topLevel, taskBranch, 'task branch')]);
  const sourceBranchRef = frozenSourceHeadSha ? requireGitObjectId(frozenSourceHeadSha, 'source commit') : localBranchRef(await assertNamedBranchExists(context.topLevel, safeSourceBranch, 'source branch'));
  const taskBranchRef = localBranchRef(safeTaskBranch);
  const [sourceHeadSha, taskHeadSha] = await Promise.all([resolveCommit(context.topLevel, sourceBranchRef), resolveCommit(context.topLevel, taskBranchRef)]);
  const [mergeBaseSha, rawCounts, numStat, nameStatus] = await Promise.all([
    requireGitStdout(context.topLevel, ['merge-base', sourceBranchRef, taskBranchRef]),
    readGitStdout(context.topLevel, ['rev-list', '--left-right', '--count', `${sourceBranchRef}...${taskBranchRef}`]),
    runGit(context.topLevel, ['diff', '--numstat', '-z', `${sourceBranchRef}...${taskBranchRef}`, '--', '.']).then((result) => result.stdout),
    runGit(context.topLevel, ['diff', '--name-status', '-z', `${sourceBranchRef}...${taskBranchRef}`, '--', '.']).then((result) => result.stdout),
  ]);
  const counts = parseAheadBehind(rawCounts);
  const statsByPath = new Map(parseGitNumStat(numStat).map((entry) => [entry.path, entry]));
  const files = parseGitNameStatus(nameStatus).map((entry) => {
    const stats = statsByPath.get(entry.path);
    return {
      path: entry.path,
      ...(entry.originalPath ? { originalPath: entry.originalPath } : {}),
      changeType: entry.changeType,
      additions: stats?.additions ?? 0,
      deletions: stats?.deletions ?? 0,
    };
  });
  return {
    sourceBranch: safeSourceBranch,
    taskBranch: safeTaskBranch,
    sourceHeadSha,
    taskHeadSha,
    mergeBaseSha,
    ...counts,
    files,
  };
}

function parseGitNameStatus(stdout: string): Array<{ path: string; originalPath?: string; changeType: GitDiffFileChangeType }> {
  const records = stdout.split('\0');
  const entries: Array<{ path: string; originalPath?: string; changeType: GitDiffFileChangeType }> = [];
  for (let index = 0; index < records.length; ) {
    const status = records[index++] ?? '';
    if (!status) continue;
    const code = status[0] ?? 'M';
    if (code === 'R' || code === 'C') {
      const originalPath = records[index++] ?? '';
      const path = records[index++] ?? '';
      if (path) entries.push({ path, ...(originalPath ? { originalPath } : {}), changeType: code === 'R' ? 'renamed' : 'copied' });
      continue;
    }
    const path = records[index++] ?? '';
    if (!path) continue;
    const changeType: GitDiffFileChangeType = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
    entries.push({ path, changeType });
  }
  return entries;
}

/** 读取任务分支单个文件的已提交差异，不依赖任务 worktree 是否仍然存在。 */
export async function getTaskBranchFileDiff(repositoryPath: string, sourceBranch: string, taskBranch: string, path: string, frozenSourceHeadSha?: string): Promise<TaskWorkspaceFileDiff> {
  const safePath = requireSafeWorkspacePath(path);
  const comparison = await getTaskBranchComparison(repositoryPath, sourceBranch, taskBranch, frozenSourceHeadSha);
  const diffText = await readGitDiffAllowChanges(repositoryPath, ['diff', '--binary', `${comparison.mergeBaseSha}..${comparison.taskHeadSha}`, '--', safePath]);
  return { path: safePath, diff: diffSummaryFromText(diffText) };
}

/** 读取本地命名分支提交，供服务端建立合入并发基线。 */
export async function getGitBranchHead(repositoryPath: string, branchName: string, repositoryContext?: GitRepositoryContext): Promise<string> {
  const context = repositoryContext ?? (await getGitRepositoryContext(repositoryPath));
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The selected project is not a Git repository.');
  const safeBranch = await assertNamedBranchExists(context.topLevel, branchName);
  return resolveCommit(context.topLevel, localBranchRef(safeBranch));
}

/**
 * 代码交付前让冲突处理开发线同时包含最新来源分支和原任务分支。
 * 新冲突保留在当前命名 worktree，交回原会话继续处理。
 */
export async function refreshConflictTaskWorkspace(input: { cwd: string; sourceBranch: string; taskBranch: string }): Promise<{ headSha: string; conflictFiles: string[] }> {
  const review = await getTaskWorkspaceReview(input.cwd);
  if (review.branch === 'detached') throw gitCoreError('ZEUS_TASK_WORKSPACE_DETACHED', 'Conflict workspace must stay on a named branch.');
  if (review.conflictFiles.length > 0) return { headSha: review.headSha, conflictFiles: review.conflictFiles };
  if (!review.clean) throw gitCoreError('ZEUS_TASK_WORKSPACE_DIRTY', 'Commit or discard every conflict workspace change before refreshing its branches.');

  for (const branch of [input.sourceBranch, input.taskBranch]) {
    const safeBranch = await assertNamedBranchExists(input.cwd, branch);
    const branchHeadSha = await resolveCommit(input.cwd, localBranchRef(safeBranch));
    if (await gitCommitIsAncestor(input.cwd, branchHeadSha, 'HEAD')) continue;
    try {
      await runGit(input.cwd, ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-ff', '--no-edit', branchHeadSha]);
    } catch (error) {
      const conflictFiles = splitLines(await readGitStdout(input.cwd, ['diff', '--name-only', '--diff-filter=U']));
      if (conflictFiles.length === 0) throw error;
      return { headSha: await resolveCommit(input.cwd, 'HEAD'), conflictFiles };
    }
  }
  return { headSha: await resolveCommit(input.cwd, 'HEAD'), conflictFiles: [] };
}

/**
 * 刷新一个明确远端并返回该次刷新后的分支快照。
 * 刷新失败必须由调用方阻断当前动作，不能继续使用旧的远端跟踪引用。
 */
export async function fetchGitRemote(
  cwd: string,
  remoteName: string,
): Promise<{
  remoteName: string;
  branches: string[];
}> {
  const remote = requireSafeGitRef(remoteName, 'remote');
  const context = await getGitRepositoryContext(cwd);
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The selected project is not a Git repository.');
  if (!context.remotes.includes(remote)) throw gitCoreError('ZEUS_TASK_GIT_REMOTE_UNAVAILABLE', `Git remote is not configured: ${remote}`);
  try {
    await execFileAsync('git', ['fetch', '--prune', '--no-tags', remote, `+refs/heads/*:refs/remotes/${remote}/*`], {
      cwd: context.topLevel,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : `Failed to refresh ${remote}.`;
    throw gitCoreError('ZEUS_GIT_REMOTE_REFRESH_FAILED', message);
  }
  const refreshed = await getGitRepositoryContext(context.topLevel);
  return {
    remoteName: remote,
    branches: refreshed.remoteBranches.filter((ref) => ref.startsWith(`${remote}/`)),
  };
}

/** 读取已经刷新到本机的远端跟踪分支提交；不会再次访问网络。 */
export async function getRemoteTrackingBranchHead(cwd: string, remoteName: string, remoteBranch: string): Promise<string | null> {
  const remote = requireSafeGitRef(remoteName, 'remote');
  const branch = await assertGitBranchFormat(cwd, remoteBranch, 'remote branch');
  return readCommitIfPresent(cwd, `refs/remotes/${remote}/${branch}`);
}

/**
 * 先整理用户选中的路径，再应用到 index 并创建本地提交。
 * 该函数不会选择文件、猜测提交说明、访问远端或静默合并来源分支。
 */
export async function commitTaskWorkspace(input: CommitTaskWorkspaceInput): Promise<CommitTaskWorkspaceResult> {
  const review = await getTaskWorkspaceReview(input.cwd, input.ignoredPaths);
  if (review.branch === 'detached') throw gitCoreError('ZEUS_TASK_WORKSPACE_DETACHED', 'Task workspace is detached and cannot be committed.');
  if (review.conflictFiles.length > 0) throw gitCoreError('ZEUS_TASK_WORKSPACE_CONFLICTED', 'Resolve all conflicts before committing.');
  const ignored = (input.ignoredPaths ?? []).map((path) => requireSafeWorkspacePath(path));
  const paths = input.selectedPaths.map((path) => requireSafeWorkspacePath(path));
  if (paths.some((path) => ignored.some((ignoredPath) => path === ignoredPath || path.startsWith(`${ignoredPath}/`)))) {
    throw gitCoreError('ZEUS_TASK_GIT_PATH_INVALID', 'Shared paths and nested repositories cannot be committed from their parent workspace.');
  }
  const formattedPaths = await formatTaskCommitPaths(input.cwd, paths);
  const mergeHeadSha = await readGitStdout(input.cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (mergeHeadSha) {
    const selected = new Set(paths);
    const mergePaths = [...review.stagedFiles, ...review.unstagedFiles, ...review.untrackedFiles].map((file) => file.path).filter((path) => !ignored.some((ignoredPath) => path === ignoredPath || path.startsWith(`${ignoredPath}/`)));
    const omitted = mergePaths.filter((path) => !selected.has(path));
    if (omitted.length > 0) {
      throw gitCoreError('ZEUS_TASK_MERGE_COMMIT_INCOMPLETE', `Merge commits must include every changed path: ${omitted.join(', ')}`);
    }
  }
  // 来源目录里的暂存改动可能先被带入 worktree；共享目录和子仓库必须从父仓 index 中明确退出。
  if (ignored.length > 0) await runGit(input.cwd, ['reset', '-q', 'HEAD', '--', ...ignored]);
  if (paths.length > 0) await runGit(input.cwd, ['add', '-A', '--', ...paths]);
  const stagedNames = paths.length > 0 ? splitLines(await readGitStdout(input.cwd, ['diff', '--cached', '--name-only', '--', ...paths])) : [];
  let committed = false;
  if (mergeHeadSha) {
    // 合并提交不能按路径局部提交；即使冲突全部选择来源侧而没有净差异，也必须结束 MERGE_HEAD。
    await runGit(input.cwd, ['commit', '-m', requireSafeGitText(input.message, 'commit message')]);
    committed = true;
  } else if (stagedNames.length > 0) {
    // 只提交用户本次选中的路径；其他预先暂存的改动继续留在 index，不得绕过本次门禁混入提交。
    await runGit(input.cwd, ['commit', '-m', requireSafeGitText(input.message, 'commit message'), '--', ...paths]);
    committed = true;
  }

  const headSha = await resolveCommit(input.cwd, 'HEAD');
  return { branch: review.branch, headSha, committed, formattedPaths };
}

/**
 * 只把任务开发线当前 HEAD 推送到记录的远端分支。
 * 该函数不读取或写入 index，也不会把未提交和已暂存改动带入远端。
 */
export async function pushTaskWorkspace(input: PushTaskWorkspaceInput): Promise<PushTaskWorkspaceResult> {
  const review = await getTaskWorkspaceReview(input.cwd, input.ignoredPaths);
  if (review.branch === 'detached') throw gitCoreError('ZEUS_TASK_WORKSPACE_DETACHED', 'Task workspace is detached and cannot be pushed.');
  if (review.conflictFiles.length > 0) throw gitCoreError('ZEUS_TASK_WORKSPACE_CONFLICTED', 'Resolve all conflicts before pushing.');

  const headSha = review.headSha;
  const remoteName = requireSafeGitRef(input.remoteName || 'origin', 'remote');
  const remoteBranch = await assertGitBranchFormat(input.cwd, input.remoteBranch || review.branch, 'remote branch');
  const remoteHeadSha = await pushBranchHead(input.cwd, remoteName, remoteBranch, headSha);
  return { branch: review.branch, headSha, remoteName, remoteBranch, remoteHeadSha };
}

/** 推送明确的本地命名分支；任务分支与合入后的来源分支共用同一套非强制保护。 */
export async function pushLocalBranch(input: PushLocalBranchInput): Promise<PushTaskWorkspaceResult> {
  const context = await getGitRepositoryContext(input.repositoryPath);
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The selected project is not a Git repository.');
  const branch = await assertNamedBranchExists(context.topLevel, input.branchName, 'local branch');
  const headSha = await resolveCommit(context.topLevel, localBranchRef(branch));
  const remoteName = requireSafeGitRef(input.remoteName, 'remote');
  const remoteHeadSha = await pushBranchHead(context.topLevel, remoteName, branch, headSha);
  return { branch, headSha, remoteName, remoteBranch: branch, remoteHeadSha };
}

/** 刷新并校验指定远端分支后执行普通推送；远端领先或分叉时拒绝覆盖。 */
async function pushBranchHead(cwd: string, remoteName: string, remoteBranch: string, headSha: string): Promise<string> {
  await fetchGitRemote(cwd, remoteName);
  const trackingRef = `refs/remotes/${remoteName}/${remoteBranch}`;
  const remoteHeadBeforePush = await readCommitIfPresent(cwd, trackingRef);
  if (remoteHeadBeforePush && remoteHeadBeforePush !== headSha) {
    const { remoteOnly } = await compareCommits(cwd, remoteHeadBeforePush, headSha);
    if (remoteOnly > 0) {
      throw gitCoreError('ZEUS_TASK_REMOTE_DIVERGED', `Remote branch ${remoteName}/${remoteBranch} contains commits that are not in local HEAD.`);
    }
  }
  try {
    await runGit(cwd, ['push', remoteName, `${headSha}:refs/heads/${remoteBranch}`]);
  } catch (error) {
    await fetchGitRemote(cwd, remoteName);
    const latestRemoteHead = await readCommitIfPresent(cwd, trackingRef);
    if (latestRemoteHead && latestRemoteHead !== headSha) {
      const { remoteOnly } = await compareCommits(cwd, latestRemoteHead, headSha);
      if (remoteOnly > 0) throw gitCoreError('ZEUS_TASK_REMOTE_DIVERGED', `Remote branch ${remoteName}/${remoteBranch} advanced before the push completed.`);
    }
    throw error;
  }
  const remoteHeadSha = await readRemoteHead(cwd, remoteName, remoteBranch);
  if (remoteHeadSha !== headSha) {
    throw gitCoreError('ZEUS_TASK_REMOTE_VERIFICATION_FAILED', `Remote ${remoteName}/${remoteBranch} does not match local HEAD after push.`);
  }
  return remoteHeadSha;
}

/** 仅当 worktree 干净且远端精确包含本地 HEAD 时回收物理目录。 */
export async function reclaimTaskWorktree(input: {
  repositoryPath: string;
  worktreePath: string;
  remoteName: string;
  remoteBranch: string;
  sourceHeadSha: string;
  ignoredPaths?: string[];
}): Promise<{ headSha: string; remoteHeadSha: string | null; unchanged: boolean }> {
  const review = await getTaskWorkspaceReview(input.worktreePath, input.ignoredPaths);
  if (!review.clean) throw gitCoreError('ZEUS_TASK_WORKSPACE_DIRTY', 'Task worktree still contains uncommitted changes.');
  const unchanged = review.headSha === input.sourceHeadSha;
  const remoteHeadSha = unchanged ? null : await readRemoteHead(input.worktreePath, input.remoteName, input.remoteBranch);
  if (!unchanged && (!remoteHeadSha || remoteHeadSha !== review.headSha)) {
    throw gitCoreError('ZEUS_TASK_REMOTE_VERIFICATION_FAILED', 'Remote branch does not exactly match the task worktree HEAD.');
  }
  const context = await getGitRepositoryContext(input.repositoryPath);
  const registered = context.worktrees.find((entry) => canonicalFilesystemPath(entry.path) === canonicalFilesystemPath(input.worktreePath));
  if (!registered) throw gitCoreError('ZEUS_TASK_WORKTREE_NOT_REGISTERED', 'Task worktree is not registered in the project repository.');
  await runGit(context.topLevel, ['worktree', 'remove', ...(input.ignoredPaths?.length ? ['--force'] : []), input.worktreePath]);
  await rm(input.worktreePath, { recursive: true, force: true });
  return { headSha: review.headSha, remoteHeadSha, unchanged };
}

/** 目标分支已完成交付后回收干净的任务 worktree；任务分支不要求存在远端副本。 */
export async function reclaimDeliveredTaskWorktree(input: { repositoryPath: string; worktreePath: string; ignoredPaths?: string[] }): Promise<{
  headSha: string;
}> {
  const review = await getTaskWorkspaceReview(input.worktreePath, input.ignoredPaths);
  if (!review.clean) throw gitCoreError('ZEUS_TASK_WORKSPACE_DIRTY', 'Task worktree still contains uncommitted changes.');
  const context = await getGitRepositoryContext(input.repositoryPath);
  const registered = context.worktrees.find((entry) => canonicalFilesystemPath(entry.path) === canonicalFilesystemPath(input.worktreePath));
  if (!registered) throw gitCoreError('ZEUS_TASK_WORKTREE_NOT_REGISTERED', 'Task worktree is not registered in the project repository.');
  await runGit(context.topLevel, ['worktree', 'remove', ...(input.ignoredPaths?.length ? ['--force'] : []), input.worktreePath]);
  await rm(input.worktreePath, { recursive: true, force: true });
  return { headSha: review.headSha };
}

/**
 * 任务进入终态时只移除物理 worktree，保留本地任务分支和远端分支。
 * 脏目录必须由调用方完成用户确认后显式传入 force，不能静默丢弃本机变化。
 */
export async function removeTaskWorktreeForTerminalStatus(input: { repositoryPath: string; worktreePath: string; force: boolean }): Promise<{ removed: boolean }> {
  const context = await getGitRepositoryContext(input.repositoryPath);
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The selected project is not a Git repository.');
  const registered = context.worktrees.find((entry) => canonicalFilesystemPath(entry.path) === canonicalFilesystemPath(input.worktreePath));
  if (!registered) {
    const pathExists = await lstat(input.worktreePath).then(
      () => true,
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      },
    );
    if (pathExists) throw gitCoreError('ZEUS_TASK_WORKTREE_NOT_REGISTERED', 'Task worktree path exists but is not registered in the project repository.');
    return { removed: false };
  }
  await runGit(context.topLevel, ['worktree', 'remove', ...(input.force ? ['--force'] : []), registered.path]);
  await rm(registered.path, { recursive: true, force: true });
  return { removed: true };
}

/**
 * 明确放弃任务分支时删除 worktree 与本地分支。
 * 不删除远端分支，避免把本机任务处置扩散为远端不可逆动作。
 */
export async function discardTaskWorktree(input: {
  repositoryPath: string;
  worktreePath: string | null;
  branchName: string;
  confirmationText: string;
}): Promise<{ branchName: string; removedWorktree: boolean; removedLocalBranch: boolean }> {
  if (input.confirmationText !== input.branchName) throw gitCoreError('ZEUS_TASK_DISCARD_CONFIRMATION_INVALID', 'Type the exact task branch name to discard it.');
  const context = await getGitRepositoryContext(input.repositoryPath);
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The selected project is not a Git repository.');
  let removedWorktree = false;
  const registered = context.worktrees.find((entry) => entry.branch === input.branchName || (input.worktreePath && canonicalFilesystemPath(entry.path) === canonicalFilesystemPath(input.worktreePath)));
  if (registered) {
    await runGit(context.topLevel, ['worktree', 'remove', '--force', registered.path]);
    await rm(registered.path, { recursive: true, force: true });
    removedWorktree = true;
  }
  const refreshed = await getGitRepositoryContext(context.topLevel);
  const removedLocalBranch = refreshed.localBranches.includes(input.branchName);
  if (removedLocalBranch) await runGit(context.topLevel, ['branch', '-D', input.branchName]);
  return { branchName: input.branchName, removedWorktree, removedLocalBranch };
}

/**
 * 在隔离 worktree 内执行任务分支合入。无冲突时只产出候选结果，
 * 最终更新来源分支前仍需调用 finalizeTaskBranchIntegration 重新校验主工作区。
 */
export async function startTaskBranchIntegration(input: {
  repositoryPath: string;
  projectSlug: string;
  integrationId: string;
  targetBranch: string;
  targetRef?: string;
  taskBranch: string;
  mode: 'merge' | 'squash';
  commitMessage: string;
}): Promise<TaskBranchIntegrationStartResult> {
  const context = await getGitRepositoryContext(input.repositoryPath);
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The selected project is not a Git repository.');
  const [targetBranch, taskBranch] = await Promise.all([assertGitBranchFormat(context.topLevel, input.targetBranch, 'target branch'), assertNamedBranchExists(context.topLevel, input.taskBranch, 'task branch')]);
  const targetRef = input.targetRef?.trim() || localBranchRef(await assertNamedBranchExists(context.topLevel, targetBranch, 'target branch'));
  const targetHeadSha = await resolveCommit(context.topLevel, targetRef);
  const taskHeadSha = await resolveCommit(context.topLevel, localBranchRef(taskBranch));
  const integrationPath = join(dirname(context.topLevel), '.zeus-worktrees', safePathSegment(input.projectSlug || basename(context.topLevel)), '.integration', safePathSegment(input.integrationId));
  const registered = context.worktrees.find((entry) => canonicalFilesystemPath(entry.path) === canonicalFilesystemPath(integrationPath));
  if (!registered) {
    await mkdir(dirname(integrationPath), { recursive: true });
    await runGit(context.topLevel, ['worktree', 'add', '--detach', integrationPath, targetHeadSha]);
  }
  try {
    if (input.mode === 'merge') {
      await runGit(integrationPath, ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-ff', '--no-edit', taskHeadSha]);
    } else {
      await runGit(integrationPath, ['-c', 'merge.conflictStyle=diff3', 'merge', '--squash', taskHeadSha]);
      const staged = splitLines(await readGitStdout(integrationPath, ['diff', '--cached', '--name-only']));
      if (staged.length > 0) await runGit(integrationPath, ['commit', '-m', requireSafeGitText(input.commitMessage, 'commit message')]);
    }
  } catch (error) {
    const conflictFiles = splitLines(await readGitStdout(integrationPath, ['diff', '--name-only', '--diff-filter=U']));
    if (conflictFiles.length === 0) throw error;
    return {
      integrationPath,
      targetBranch,
      targetHeadSha,
      taskBranch,
      taskHeadSha,
      mode: input.mode,
      state: 'conflicted',
      resultHeadSha: null,
      conflictFiles,
    };
  }
  return {
    integrationPath,
    targetBranch,
    targetHeadSha,
    taskBranch,
    taskHeadSha,
    mode: input.mode,
    state: 'ready',
    resultHeadSha: await resolveCommit(integrationPath, 'HEAD'),
    conflictFiles: [],
  };
}

/** 为一次 AI 冲突处理创建独立命名分支和持久 worktree。 */
export async function startTaskIntegrationAttempt(input: {
  repositoryPath: string;
  projectSlug: string;
  integrationId: string;
  attemptId: string;
  targetBranch: string;
  targetHeadSha: string;
  taskBranch: string;
  taskHeadSha: string;
  conflictBranch: string;
  mode: 'merge' | 'squash';
  commitMessage: string;
}): Promise<TaskBranchIntegrationStartResult> {
  const context = await getGitRepositoryContext(input.repositoryPath);
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The selected project is not a Git repository.');
  const targetBranch = await assertGitBranchFormat(context.topLevel, input.targetBranch, 'target branch');
  const taskBranch = await assertGitBranchFormat(context.topLevel, input.taskBranch, 'task branch');
  const conflictBranch = await assertGitBranchFormat(context.topLevel, input.conflictBranch, 'conflict branch');
  const targetHeadSha = await resolveCommit(context.topLevel, requireGitObjectId(input.targetHeadSha, 'target head'));
  const taskHeadSha = await resolveCommit(context.topLevel, requireGitObjectId(input.taskHeadSha, 'task head'));
  const integrationPath = join(dirname(context.topLevel), '.zeus-worktrees', safePathSegment(input.projectSlug || basename(context.topLevel)), '.integration-attempts', safePathSegment(input.integrationId), safePathSegment(input.attemptId));
  const registered = context.worktrees.find((entry) => canonicalFilesystemPath(entry.path) === canonicalFilesystemPath(integrationPath));
  if (registered) {
    if (registered.branch !== conflictBranch || registered.detached) {
      throw gitCoreError('ZEUS_TASK_CONFLICT_BRANCH_MISMATCH', 'The conflict worktree is not attached to its recorded conflict branch.');
    }
    const conflictFiles = splitLines(await readGitStdout(integrationPath, ['diff', '--name-only', '--diff-filter=U']));
    return {
      integrationPath,
      targetBranch,
      targetHeadSha,
      taskBranch,
      taskHeadSha,
      mode: input.mode,
      state: conflictFiles.length > 0 ? 'conflicted' : 'ready',
      resultHeadSha: conflictFiles.length > 0 ? null : await resolveCommit(integrationPath, 'HEAD'),
      conflictFiles,
    };
  }
  await mkdir(dirname(integrationPath), { recursive: true });
  if (context.localBranches.includes(conflictBranch)) await runGit(context.topLevel, ['worktree', 'add', integrationPath, conflictBranch]);
  else await runGit(context.topLevel, ['worktree', 'add', '-b', conflictBranch, integrationPath, targetHeadSha]);
  try {
    if (input.mode === 'merge') {
      await runGit(integrationPath, ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-ff', '--no-edit', taskHeadSha]);
    } else {
      await runGit(integrationPath, ['-c', 'merge.conflictStyle=diff3', 'merge', '--squash', taskHeadSha]);
      const staged = splitLines(await readGitStdout(integrationPath, ['diff', '--cached', '--name-only']));
      if (staged.length > 0) await runGit(integrationPath, ['commit', '-m', requireSafeGitText(input.commitMessage, 'commit message')]);
    }
  } catch (error) {
    const conflictFiles = splitLines(await readGitStdout(integrationPath, ['diff', '--name-only', '--diff-filter=U']));
    if (conflictFiles.length === 0) {
      await cleanupTaskIntegrationWorktree({ repositoryPath: context.topLevel, integrationPath }).catch(() => undefined);
      throw error;
    }
    return { integrationPath, targetBranch, targetHeadSha, taskBranch, taskHeadSha, mode: input.mode, state: 'conflicted', resultHeadSha: null, conflictFiles };
  }
  return {
    integrationPath,
    targetBranch,
    targetHeadSha,
    taskBranch,
    taskHeadSha,
    mode: input.mode,
    state: 'ready',
    resultHeadSha: await resolveCommit(integrationPath, 'HEAD'),
    conflictFiles: [],
  };
}

/** 读取三方冲突内容：source 是来源分支，task 是任务分支，result 是当前可编辑结果。 */
export async function readTaskIntegrationConflict(integrationPath: string, path: string): Promise<TaskIntegrationConflictFile> {
  const safePath = requireSafeWorkspacePath(path);
  const conflicts = splitLines(await readGitStdout(integrationPath, ['diff', '--name-only', '--diff-filter=U']));
  if (!conflicts.includes(safePath)) throw gitCoreError('ZEUS_TASK_CONFLICT_NOT_FOUND', `Conflict file is no longer unresolved: ${safePath}`);
  const [base, source, task, result] = await Promise.all([
    readGitStageText(integrationPath, 1, safePath),
    readGitStageText(integrationPath, 2, safePath),
    readGitStageText(integrationPath, 3, safePath),
    readWorkspaceText(integrationPath, safePath),
  ]);
  const fingerprint = createHash('sha256').update(safePath).update('\0').update(base).update('\0').update(source).update('\0').update(task).digest('hex');
  return { path: safePath, fingerprint, base, source, task, result };
}

/** 保存用户确认后的中间结果并暂存；未解决的其他文件保持冲突态。 */
export async function writeTaskIntegrationResolution(integrationPath: string, path: string, content: string): Promise<{ path: string; remainingConflictFiles: string[] }> {
  const safePath = requireSafeWorkspacePath(path);
  if (content.includes('\0')) throw gitCoreError('ZEUS_TASK_CONFLICT_BINARY_UNSUPPORTED', 'Binary conflict resolution is not supported in the text editor.');
  const absolutePath = resolve(integrationPath, safePath);
  if (!isPathInside(integrationPath, absolutePath)) throw gitCoreError('ZEUS_GIT_PATH_INVALID', `Conflict path escapes the integration worktree: ${safePath}`);
  await writeFile(absolutePath, content, 'utf8');
  await runGit(integrationPath, ['add', '--', safePath]);
  const remainingConflictFiles = splitLines(await readGitStdout(integrationPath, ['diff', '--name-only', '--diff-filter=U']));
  return { path: safePath, remainingConflictFiles };
}

/** AI 接管前只把当前三栏草稿写入隔离工作区，保留未解决 marker，不暂存也不生成提交。 */
export async function writeTaskIntegrationDraft(integrationPath: string, path: string, content: string): Promise<{ path: string }> {
  const safePath = requireSafeWorkspacePath(path);
  if (content.includes('\0')) throw gitCoreError('ZEUS_TASK_CONFLICT_BINARY_UNSUPPORTED', 'Binary conflict resolution is not supported in the text editor.');
  const absolutePath = resolve(integrationPath, safePath);
  if (!isPathInside(integrationPath, absolutePath)) throw gitCoreError('ZEUS_GIT_PATH_INVALID', `Conflict path escapes the integration worktree: ${safePath}`);
  await writeFile(absolutePath, content, 'utf8');
  return { path: safePath };
}

/** 冲突全部解决后生成合入候选提交；仍有冲突时拒绝继续。 */
export async function completeTaskIntegrationCommit(input: { integrationPath: string; mode: 'merge' | 'squash'; commitMessage: string }): Promise<{ resultHeadSha: string }> {
  const conflicts = splitLines(await readGitStdout(input.integrationPath, ['diff', '--name-only', '--diff-filter=U']));
  if (conflicts.length > 0) throw gitCoreError('ZEUS_TASK_WORKSPACE_CONFLICTED', 'Resolve every conflict before completing the integration commit.');
  const mergeHead = await readGitStdout(input.integrationPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  const staged = splitLines(await readGitStdout(input.integrationPath, ['diff', '--cached', '--name-only']));
  if (mergeHead) {
    await runGit(input.integrationPath, ['commit', '--no-edit']);
  } else if (input.mode === 'squash' && staged.length > 0) {
    await runGit(input.integrationPath, ['commit', '-m', requireSafeGitText(input.commitMessage, 'commit message')]);
  }
  return { resultHeadSha: await resolveCommit(input.integrationPath, 'HEAD') };
}

/** 重新校验来源分支提交后只同步本地来源分支；远端推送由独立用户动作完成。 */
export async function finalizeTaskBranchIntegration(input: { repositoryPath: string; integrationPath: string; targetBranch: string; targetHeadSha: string; resultHeadSha: string }): Promise<FinalizedTaskBranchIntegration> {
  const targetBranch = await assertGitBranchFormat(input.repositoryPath, input.targetBranch, 'target branch');
  const resultHeadSha = requireGitObjectId(input.resultHeadSha, 'integration result');
  const targetHeadSha = await readCommitIfPresent(input.repositoryPath, localBranchRef(targetBranch));
  const resolvedTargetHeadSha = targetHeadSha ?? input.targetHeadSha;
  if (resolvedTargetHeadSha !== input.targetHeadSha) throw gitCoreError('ZEUS_TARGET_HEAD_CHANGED', 'Target branch advanced while the integration was being prepared.');

  const localSync = await syncLocalTargetBranch({
    repositoryPath: input.repositoryPath,
    targetBranch,
    targetHeadSha: input.targetHeadSha,
    resultHeadSha,
  });
  // 本地来源分支暂时不安全时保留隔离合入结果，待用户清理原工作区后重试同步。
  if (localSync.localSyncStatus === 'synced') {
    const context = await getGitRepositoryContext(input.repositoryPath);
    const registered = context.worktrees.find((entry) => canonicalFilesystemPath(entry.path) === canonicalFilesystemPath(input.integrationPath));
    if (registered) {
      await runGit(context.topLevel, ['worktree', 'remove', input.integrationPath]);
      await rm(input.integrationPath, { recursive: true, force: true });
    }
  }
  return {
    targetBranch,
    targetHeadSha: input.targetHeadSha,
    resultHeadSha,
    remoteName: '',
    remoteHeadSha: null,
    ...localSync,
  };
}

/** 只回收已登记在 Zeus worktree 容器内的临时合入目录。 */
export async function cleanupTaskIntegrationWorktree(input: { repositoryPath: string; integrationPath: string }): Promise<boolean> {
  const context = await getGitRepositoryContext(input.repositoryPath);
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The selected project is not a Git repository.');
  const integrationPath = resolve(input.integrationPath);
  const containerRoot = resolve(join(dirname(context.topLevel), '.zeus-worktrees'));
  if (!isPathInside(containerRoot, integrationPath)) throw gitCoreError('ZEUS_GIT_PATH_INVALID', 'Integration worktree is outside the Zeus worktree container.');
  const registered = context.worktrees.find((entry) => canonicalFilesystemPath(entry.path) === canonicalFilesystemPath(integrationPath));
  if (!registered) return false;
  await runGit(context.topLevel, ['worktree', 'remove', '--force', integrationPath]);
  await rm(integrationPath, { recursive: true, force: true });
  return true;
}

/** 本地合入完成后尽力同步来源分支；任何本地风险都降级为待同步，不反写用户现场。 */
async function syncLocalTargetBranch(input: {
  repositoryPath: string;
  targetBranch: string;
  targetHeadSha: string;
  resultHeadSha: string;
}): Promise<Pick<FinalizedTaskBranchIntegration, 'localSyncStatus' | 'localHeadSha' | 'localWorktreePath'>> {
  const context = await getGitRepositoryContext(input.repositoryPath);
  const checkedOut = context.worktrees.find((entry) => entry.branch === input.targetBranch) ?? null;
  if (checkedOut) {
    try {
      // Git 会保留不受快进影响的本机改动，并在可能覆盖改动时自行拒绝；不要把任意脏文件都误判成合入失败。
      await runGit(checkedOut.path, ['merge', '--ff-only', input.resultHeadSha]);
      const localHeadSha = await resolveCommit(checkedOut.path, 'HEAD');
      return localHeadSha === input.resultHeadSha ? { localSyncStatus: 'synced', localHeadSha, localWorktreePath: checkedOut.path } : { localSyncStatus: 'pending', localHeadSha, localWorktreePath: checkedOut.path };
    } catch {
      const localHeadSha = await resolveCommit(input.repositoryPath, localBranchRef(input.targetBranch)).catch(() => input.targetHeadSha);
      return {
        localSyncStatus: localHeadSha === input.resultHeadSha ? 'synced' : 'pending',
        localHeadSha,
        localWorktreePath: checkedOut.path,
      };
    }
  }

  const currentLocalHead = await readCommitIfPresent(input.repositoryPath, localBranchRef(input.targetBranch));
  try {
    if (currentLocalHead) {
      const { localOnly } = await compareCommits(input.repositoryPath, input.resultHeadSha, currentLocalHead);
      if (localOnly > 0) {
        return { localSyncStatus: 'pending', localHeadSha: currentLocalHead, localWorktreePath: null };
      }
      await runGit(input.repositoryPath, ['update-ref', `refs/heads/${input.targetBranch}`, input.resultHeadSha, currentLocalHead]);
    } else {
      await runGit(input.repositoryPath, ['update-ref', `refs/heads/${input.targetBranch}`, input.resultHeadSha]);
    }
  } catch {
    const localHeadSha = await resolveCommit(input.repositoryPath, localBranchRef(input.targetBranch)).catch(() => currentLocalHead ?? input.targetHeadSha);
    return {
      localSyncStatus: localHeadSha === input.resultHeadSha ? 'synced' : 'pending',
      localHeadSha,
      localWorktreePath: null,
    };
  }
  return { localSyncStatus: 'synced', localHeadSha: input.resultHeadSha, localWorktreePath: null };
}

export type HighRiskGitOperation = 'commit' | 'stash' | 'apply_stash' | 'rollback' | 'branch' | 'switch_branch' | 'pull' | 'push';
export type GitOperationConfirmationStatus = 'pending' | 'confirmed' | 'rejected';

export interface CreateGitOperationConfirmationInput {
  operation: HighRiskGitOperation;
  cwd: string;
  reason: string;
  message?: string;
}

export interface GitOperationConfirmation extends CreateGitOperationConfirmationInput {
  id: string;
  status: GitOperationConfirmationStatus;
  riskLevel: 'high';
  confirmationText: string;
  createdAt: string;
  expiresAt: string;
  confirmedAt?: string;
  rejectedAt?: string;
  rejectedReason?: string;
}

export interface CreateGitOperationConfirmationOptions {
  createdAt?: Date;
  ttlMs?: number;
}

export interface GitRunnerResult {
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (cwd: string, args: string[]) => Promise<GitRunnerResult>;

export interface ExecuteHighRiskGitOperationInput {
  confirmation: GitOperationConfirmation;
  operation: HighRiskGitOperation;
  message?: string;
  branchName?: string;
  baseRef?: string;
  stashRef?: string;
  remote?: string;
  targetRef?: string;
  runner?: GitCommandRunner;
}

export interface ExecutedGitOperationResult extends GitRunnerResult {
  operation: HighRiskGitOperation;
  cwd: string;
  args: string[];
}

/**
 * 为 Git 写操作创建二次确认记录；该函数只生成确认意图，不执行任何 Git 命令。
 */
export function createGitOperationConfirmation(input: CreateGitOperationConfirmationInput, options: CreateGitOperationConfirmationOptions = {}): GitOperationConfirmation {
  const createdAtDate = options.createdAt ?? new Date();
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const createdAt = createdAtDate.toISOString();
  const expiresAt = new Date(createdAtDate.getTime() + ttlMs).toISOString();
  return {
    ...input,
    id: `git-confirm-${createdAt}-${input.operation}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
    status: 'pending',
    riskLevel: 'high',
    confirmationText: gitConfirmationText(input.operation),
    createdAt,
    expiresAt,
  };
}

/** 将等待确认的 Git 操作标记为已确认，调用方拿到确认后才能执行真实 Git 写命令。 */
export function confirmGitOperation(confirmation: GitOperationConfirmation, confirmedAt = new Date()): GitOperationConfirmation {
  return {
    ...confirmation,
    status: 'confirmed',
    confirmedAt: confirmedAt.toISOString(),
  };
}

/** 将等待确认的 Git 操作标记为已拒绝；拒绝只记录用户意图，不执行任何 Git 写命令。 */
export function rejectGitOperation(confirmation: GitOperationConfirmation, rejectedAt = new Date(), rejectedReason?: string): GitOperationConfirmation {
  return {
    ...confirmation,
    status: 'rejected',
    rejectedAt: rejectedAt.toISOString(),
    rejectedReason,
  };
}

/** 判断 Git 高风险确认是否已过期；过期确认不能再用于执行写操作。 */
export function isGitConfirmationExpired(confirmation: GitOperationConfirmation, now = new Date()): boolean {
  return now.getTime() >= new Date(confirmation.expiresAt).getTime();
}

function gitConfirmationText(operation: HighRiskGitOperation): string {
  const labels: Record<HighRiskGitOperation, string> = {
    commit: 'Git commit',
    stash: 'Git stash',
    apply_stash: 'Git stash apply',
    rollback: 'Git rollback',
    branch: 'Git branch',
    switch_branch: 'Git switch',
    pull: 'Git pull',
    push: 'Git push',
  };
  return `确认执行 ${labels[operation]}`;
}

/** 在确认完成后执行受控 Git 写操作；参数由白名单构造，调用方不能传入任意 git 子命令。 */
export async function executeHighRiskGitOperation(input: ExecuteHighRiskGitOperationInput): Promise<ExecutedGitOperationResult> {
  if (input.confirmation.status !== 'confirmed') {
    throw new Error('Git operation requires a confirmed confirmation');
  }
  if (input.confirmation.operation !== input.operation) {
    throw new Error('Git operation must match the confirmed operation');
  }
  const args = buildHighRiskGitOperationArgs(input);
  const runner = input.runner ?? defaultGitCommandRunner;
  const output = await runner(input.confirmation.cwd, args);
  return {
    operation: input.operation,
    cwd: input.confirmation.cwd,
    args,
    stdout: output.stdout,
    stderr: output.stderr,
  };
}

function buildHighRiskGitOperationArgs(input: ExecuteHighRiskGitOperationInput): string[] {
  switch (input.operation) {
    case 'commit':
      return ['commit', '-m', requireSafeGitText(input.message ?? input.confirmation.message, 'commit message')];
    case 'stash':
      return ['stash', 'push', '-m', requireSafeGitText(input.message ?? input.confirmation.message ?? input.confirmation.reason, 'stash message')];
    case 'apply_stash':
      return ['stash', 'apply', requireSafeGitRef(input.stashRef ?? 'stash@{0}', 'stash ref')];
    case 'rollback':
      return ['restore', '--source', requireSafeGitRef(input.targetRef ?? 'HEAD', 'rollback ref'), '--', '.'];
    case 'branch':
      return ['switch', '-c', requireSafeGitRef(input.branchName, 'branch name'), ...(input.baseRef ? [requireSafeGitRef(input.baseRef, 'base ref')] : [])];
    case 'switch_branch':
      return ['switch', requireSafeGitRef(input.branchName, 'branch name')];
    case 'pull':
      return ['pull', '--ff-only', requireSafeGitRef(input.remote ?? 'origin', 'remote'), requireSafeGitRef(input.targetRef ?? 'HEAD', 'pull ref')];
    case 'push':
      return ['push', requireSafeGitRef(input.remote ?? 'origin', 'remote'), requireSafeGitRef(input.targetRef ?? 'HEAD', 'push ref')];
  }
}

function requireSafeGitText(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`Git ${label} is required`);
  if (normalized.includes('\0')) throw new Error(`Git ${label} contains unsafe characters`);
  return normalized;
}

function requireSafeGitRef(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`Git ${label} is required`);
  if (!/^[A-Za-z0-9._/@{}:+~-]+$/u.test(normalized) || normalized.includes('..') || normalized.startsWith('-')) {
    throw new Error(`Git ${label} contains unsafe characters`);
  }
  return normalized;
}

function requireGitObjectId(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? '';
  if (!/^[0-9a-f]{40,64}$/u.test(normalized)) throw gitCoreError('ZEUS_GIT_OBJECT_ID_INVALID', `Git ${label} must be an exact object ID.`);
  return normalized;
}

/** 分支名称只服从 Git 自身规则，避免手写字符白名单拒绝中文或 # 等合法字符。 */
async function assertGitBranchFormat(cwd: string, branchName: string | undefined, label: string): Promise<string> {
  const normalized = branchName?.trim() ?? '';
  if (!normalized) throw gitCoreError('ZEUS_GIT_BRANCH_REQUIRED', `Git ${label} is required.`);
  try {
    await execFileAsync('git', ['check-ref-format', '--branch', normalized], { cwd });
  } catch {
    throw gitCoreError('ZEUS_GIT_BRANCH_INVALID', `Invalid Git ${label}: ${normalized}`);
  }
  return normalized;
}

function localBranchRef(branchName: string): string {
  return `refs/heads/${branchName}`;
}

async function defaultGitCommandRunner(cwd: string, args: string[]): Promise<GitRunnerResult> {
  const result = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function runGit(cwd: string, args: string[]): Promise<GitRunnerResult> {
  try {
    return await defaultGitCommandRunner(cwd, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Git command failed.';
    throw gitCoreError('ZEUS_GIT_COMMAND_FAILED', message);
  }
}

async function gitCommitIsAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    const message = error instanceof Error ? error.message : 'Git ancestry check failed.';
    throw gitCoreError('ZEUS_GIT_COMMAND_FAILED', message);
  }
}

/** 合并类命令遇到真实冲突时保留现场并返回输出；其他失败仍按错误处理。 */
async function runGitPreservingConflict(cwd: string, args: string[]): Promise<GitRunnerResult> {
  try {
    return await defaultGitCommandRunner(cwd, args);
  } catch (error) {
    const status = await getGitStatus(cwd).catch(() => emptyGitStatus());
    if (status.conflictFiles.length === 0) {
      const message = error instanceof Error ? error.message : 'Git command failed.';
      throw gitCoreError('ZEUS_GIT_COMMAND_FAILED', message);
    }
    const candidate = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      stdout: typeof candidate.stdout === 'string' ? candidate.stdout : '',
      stderr: typeof candidate.stderr === 'string' ? candidate.stderr : typeof candidate.message === 'string' ? candidate.message : 'Git operation stopped on conflicts.',
    };
  }
}

async function requireGitStdout(cwd: string, args: string[]): Promise<string> {
  return (await runGit(cwd, args)).stdout.trim();
}

async function resolveCommit(cwd: string, ref: string): Promise<string> {
  const normalized = requireSafeGitText(ref, 'Git revision');
  try {
    return await requireGitStdout(cwd, ['rev-parse', '--verify', '--end-of-options', `${normalized}^{commit}`]);
  } catch {
    throw gitCoreError('ZEUS_GIT_REF_NOT_FOUND', `Git ref does not resolve to a commit: ${normalized}`);
  }
}

async function assertNamedBranchExists(cwd: string, branchName: string, label = 'branch name'): Promise<string> {
  const branch = await assertGitBranchFormat(cwd, branchName, label);
  const exists = await readGitStdout(cwd, ['show-ref', '--verify', '--hash', localBranchRef(branch)]);
  if (!exists) throw gitCoreError('ZEUS_GIT_BRANCH_NOT_FOUND', `Local branch does not exist: ${branch}`);
  return branch;
}

/** 校验一次远端刷新快照中的分支，并返回不含远端名前缀的业务分支名。 */
async function assertRemoteBranchExists(cwd: string, remoteRef: string, expectedBranch?: string): Promise<string> {
  const normalized = remoteRef.trim();
  const separator = normalized.indexOf('/');
  if (separator <= 0) throw gitCoreError('ZEUS_TASK_SOURCE_BRANCH_INVALID', `Remote source branch is invalid: ${normalized}`);
  const remoteName = requireSafeGitRef(normalized.slice(0, separator), 'remote');
  const branch = await assertGitBranchFormat(cwd, expectedBranch?.trim() || normalized.slice(separator + 1), 'source branch');
  if (normalized !== `${remoteName}/${branch}`) throw gitCoreError('ZEUS_TASK_SOURCE_BRANCH_INVALID', `Remote source branch does not match its selected remote: ${normalized}`);
  const exists = await readGitStdout(cwd, ['show-ref', '--verify', '--hash', `refs/remotes/${remoteName}/${branch}`]);
  if (!exists) throw gitCoreError('ZEUS_GIT_BRANCH_NOT_FOUND', `Remote branch does not exist in the refreshed snapshot: ${normalized}`);
  return branch;
}

async function readCommitIfPresent(cwd: string, ref: string): Promise<string | null> {
  const stdout = await readGitStdout(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
  return /^[0-9a-f]{40,64}$/u.test(stdout) ? stdout : null;
}

async function compareCommits(
  cwd: string,
  remoteCommit: string,
  localCommit: string,
): Promise<{
  remoteOnly: number;
  localOnly: number;
}> {
  const [remoteOnlyText = '0', localOnlyText = '0'] = (await requireGitStdout(cwd, ['rev-list', '--left-right', '--count', `${remoteCommit}...${localCommit}`])).split(/\s+/u);
  return {
    remoteOnly: Number.parseInt(remoteOnlyText, 10) || 0,
    localOnly: Number.parseInt(localOnlyText, 10) || 0,
  };
}

function parseGitWorktreeList(stdout: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = {
        path: line.slice('worktree '.length),
        headSha: '',
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.headSha = line.slice('HEAD '.length);
    } else if (line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line.startsWith('locked')) {
      current.locked = true;
    } else if (line.startsWith('prunable')) {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function buildTaskWorktreePath(topLevel: string, projectSlug: string, taskCode: string, workspaceId: string): string {
  const root = join(dirname(topLevel), '.zeus-worktrees');
  const safeProject = safePathSegment(projectSlug || basename(topLevel));
  const safeTask = safePathSegment(taskCode);
  const safeWorkspace = safePathSegment(workspaceId).slice(-16) || 'workspace';
  return join(root, safeProject, safeWorkspace, safeTask);
}

function safePathSegment(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64);
}

function requireSafeWorkspacePath(value: string): string {
  const normalized = value.trim();
  if (!normalized || isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${sep}`) || relative('.', normalized).startsWith(`..${sep}`) || normalized.includes('\0')) {
    throw gitCoreError('ZEUS_GIT_PATH_INVALID', `Invalid workspace-relative path: ${value}`);
  }
  return normalized;
}

/** 项目显式使用本地 Prettier 时，只整理本次提交选中的现存普通文件。 */
async function formatTaskCommitPaths(cwd: string, selectedPaths: string[]): Promise<string[]> {
  if (!(await projectDeclaresPrettier(cwd))) return [];

  const prettierPath = await resolveTaskPrettierPath(cwd);
  if (!prettierPath) throw gitCoreError('ZEUS_TASK_PRECOMMIT_FORMAT_UNAVAILABLE', '项目配置了 Prettier，但仓库尚未安装本地 Prettier。请先安装项目依赖再提交。');
  const prettierEntrypoint = await resolveTaskPrettierEntrypoint(prettierPath);
  if (!prettierEntrypoint) throw gitCoreError('ZEUS_TASK_PRECOMMIT_FORMAT_UNAVAILABLE', '项目配置了 Prettier，但本地 Prettier 入口无法解析。请先安装项目依赖再提交。');

  const existingFiles: string[] = [];
  const before = new Map<string, Buffer>();
  for (const path of selectedPaths) {
    const absolutePath = resolve(cwd, path);
    if (!isPathInside(cwd, absolutePath)) throw gitCoreError('ZEUS_GIT_PATH_INVALID', `Workspace path escapes the task worktree: ${path}`);
    const entry = await lstat(absolutePath).catch(() => null);
    // 符号链接不交给格式化器，避免跟随链接改写任务工作区之外的目标。
    if (!entry?.isFile() || entry.isSymbolicLink()) continue;
    existingFiles.push(path);
    before.set(path, await readFile(absolutePath));
  }
  if (existingFiles.length === 0) return [];

  const ignorePath = join(cwd, '.prettierignore');
  const ignoreEntry = await lstat(ignorePath).catch(() => null);
  const commonArgs = [...(ignoreEntry?.isFile() ? ['--ignore-path', '.prettierignore'] : []), '--ignore-unknown'];
  const absoluteFiles = existingFiles.map((path) => resolve(cwd, path));
  const prettierEnvironment = process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env;
  try {
    await execFileAsync(process.execPath, [prettierEntrypoint, '--write', ...commonArgs, ...absoluteFiles], {
      cwd,
      env: prettierEnvironment,
      maxBuffer: 20 * 1024 * 1024,
    });
    await execFileAsync(process.execPath, [prettierEntrypoint, '--check', ...commonArgs, ...absoluteFiles], {
      cwd,
      env: prettierEnvironment,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw gitCoreError('ZEUS_TASK_PRECOMMIT_FORMAT_FAILED', `提交前 Prettier 格式化失败：${commandFailureDetail(error)}`);
  }

  const formattedPaths: string[] = [];
  for (const path of existingFiles) {
    const previous = before.get(path);
    const current = await readFile(resolve(cwd, path));
    if (previous && !previous.equals(current)) formattedPaths.push(path);
  }
  return formattedPaths;
}

async function resolveTaskPrettierPath(cwd: string): Promise<string | null> {
  const candidates = [join(cwd, 'node_modules', '.bin', 'prettier')];
  // Git worktree 默认不复制 node_modules；允许复用同一仓库主工作区已经安装的固定版本。
  const commonGitDirectory = await readGitStdout(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => null);
  if (commonGitDirectory) candidates.push(join(dirname(commonGitDirectory), 'node_modules', '.bin', 'prettier'));
  for (const candidate of new Set(candidates)) {
    const entry = await lstat(candidate).catch(() => null);
    if (entry && !entry.isDirectory()) return candidate;
  }
  return null;
}

/** 解析项目本地 Prettier 的 JavaScript 入口，避免执行依赖外部 node 命令的 shell 包装器。 */
async function resolveTaskPrettierEntrypoint(prettierPath: string): Promise<string | null> {
  const resolvedPath = await realpath(prettierPath).catch(() => null);
  if (resolvedPath && isJavaScriptEntrypoint(resolvedPath)) return resolvedPath;

  const packageRoot = resolve(dirname(prettierPath), '..', 'prettier');
  const packageManifest = await readFile(join(packageRoot, 'package.json'), 'utf8').catch(() => null);
  if (!packageManifest) return null;

  let binPath: string | null = null;
  try {
    const manifest = JSON.parse(packageManifest) as { bin?: unknown };
    binPath = readPrettierBinPath(manifest.bin);
  } catch {
    return null;
  }
  if (!binPath) return null;

  const entrypoint = resolve(packageRoot, binPath);
  if (!isPathInside(packageRoot, entrypoint)) return null;
  const entry = await lstat(entrypoint).catch(() => null);
  return entry && !entry.isDirectory() ? entrypoint : null;
}

function readPrettierBinPath(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const entries = value as Record<string, unknown>;
  const preferred = entries.prettier;
  if (typeof preferred === 'string') return preferred;
  const firstPath = Object.values(entries).find((entry) => typeof entry === 'string');
  return typeof firstPath === 'string' ? firstPath : null;
}

function isJavaScriptEntrypoint(value: string): boolean {
  return /\.(?:cjs|mjs|js)$/iu.test(value);
}

async function projectDeclaresPrettier(cwd: string): Promise<boolean> {
  const packageJsonPath = join(cwd, 'package.json');
  const packageJson = await readFile(packageJsonPath, 'utf8').catch(() => null);
  if (!packageJson) return false;
  try {
    const manifest = JSON.parse(packageJson) as Record<string, unknown>;
    return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some((field) => {
      const dependencies = manifest[field];
      return typeof dependencies === 'object' && dependencies !== null && Object.prototype.hasOwnProperty.call(dependencies, 'prettier');
    });
  } catch {
    // package.json 正在编辑且暂时不是合法 JSON 时，仍识别显式声明，交由 Prettier 给出准确错误。
    return /"prettier"\s*:/u.test(packageJson);
  }
}

function commandFailureDetail(error: unknown): string {
  const failure = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const detail = [failure.stderr, failure.stdout, failure.message].find((value) => typeof value === 'string' && value.trim());
  return typeof detail === 'string' ? detail.trim().slice(0, 4_000) : '命令执行失败。';
}

/** 统一 macOS 等系统上的符号链接路径，避免同一 worktree 因 /tmp 与 /private/tmp 被误判。 */
function canonicalFilesystemPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function parseAheadBehind(stdout: string): { ahead: number; behind: number } {
  const [behindText = '0', aheadText = '0'] = stdout.trim().split(/\s+/u);
  return {
    ahead: Number.parseInt(aheadText, 10) || 0,
    behind: Number.parseInt(behindText, 10) || 0,
  };
}

async function readGitDiffAllowChanges(cwd: string, args: string[]): Promise<string> {
  try {
    return (await execFileAsync('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 })).stdout;
  } catch (error) {
    const output = (error as { stdout?: unknown }).stdout;
    if (typeof output === 'string') return output;
    throw error;
  }
}

function diffSummaryFromText(diffText: string): GitDiffSummary {
  const fileDiffs = parseGitUnifiedDiff(diffText);
  return {
    isRepository: true,
    files: Array.from(new Set(fileDiffs.flatMap((file) => [file.newPath || file.oldPath]).filter(Boolean))),
    diffText,
    fileDiffs,
  };
}

async function readRemoteHead(cwd: string, remoteName: string, remoteBranch: string): Promise<string | null> {
  const remote = requireSafeGitRef(remoteName, 'remote');
  const branch = await assertGitBranchFormat(cwd, remoteBranch, 'remote branch');
  const stdout = await readGitStdout(cwd, ['ls-remote', '--heads', remote, localBranchRef(branch)]);
  const [sha = ''] = stdout.trim().split(/\s+/u);
  return /^[0-9a-f]{40,64}$/u.test(sha) ? sha : null;
}

async function readGitStageText(cwd: string, stage: 1 | 2 | 3, path: string): Promise<string> {
  try {
    return (await execFileAsync('git', ['show', `:${stage}:${path}`], { cwd, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch {
    return '';
  }
}

async function readWorkspaceText(cwd: string, path: string): Promise<string> {
  const absolutePath = resolve(cwd, path);
  if (!isPathInside(cwd, absolutePath)) throw gitCoreError('ZEUS_GIT_PATH_INVALID', `Workspace path escapes the integration worktree: ${path}`);
  const bytes = await readFile(absolutePath);
  if (bytes.includes(0)) throw gitCoreError('ZEUS_TASK_CONFLICT_BINARY_UNSUPPORTED', 'Binary conflict resolution is not supported in the text editor.');
  if (bytes.byteLength > 4 * 1024 * 1024) throw gitCoreError('ZEUS_TASK_CONFLICT_TOO_LARGE', 'Conflict file is too large for the built-in editor.');
  return bytes.toString('utf8');
}

function gitCoreError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** 只读获取 Git 状态，不执行提交、回退、合并等高风险写操作。 */
export async function getGitStatus(cwd: string): Promise<GitStatusSummary> {
  try {
    const branch = (await execFileAsync('git', ['branch', '--show-current'], { cwd })).stdout.trim() || 'detached';
    const porcelain = (await execFileAsync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd })).stdout;
    const parsedStatus = parseGitPorcelainStatus(porcelain);
    const remoteBranches = splitLines(await readGitStdout(cwd, ['branch', '-r', '--format=%(refname:short)']));
    const recentCommits = parseRecentCommits(await readGitStdout(cwd, ['-c', 'core.quotePath=false', 'log', '-n', '5', '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%P']));
    return {
      isRepository: true,
      branch,
      remoteBranches,
      recentCommits,
      ...parsedStatus,
    };
  } catch {
    return emptyGitStatus();
  }
}

/** 为项目 Git 工作台读取单仓完整快照；所有字段都来自当前本机仓库。 */
export async function getProjectGitRepositorySnapshot(cwd: string): Promise<ProjectGitRepositorySnapshot> {
  const context = await getGitRepositoryContext(cwd);
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The selected directory is not a Git repository.');
  const [status, diff, stagedDiffText, unstagedDiffText, upstreamText, tagsText, headTagsText, reflogText, stashText, recentText] = await Promise.all([
    getGitStatus(context.topLevel),
    getGitDiff(context.topLevel),
    readGitStdout(context.topLevel, ['-c', 'core.quotePath=false', 'diff', '--cached', '--', '.']),
    readGitStdout(context.topLevel, ['-c', 'core.quotePath=false', 'diff', '--', '.']),
    readGitStdout(context.topLevel, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    readGitStdout(context.topLevel, ['tag', '--sort=-creatordate']),
    readGitStdout(context.topLevel, ['tag', '--points-at', 'HEAD', '--sort=-creatordate']),
    readGitStdout(context.topLevel, ['reflog', '-n', '120', '--format=%gs']),
    readGitStdout(context.topLevel, ['stash', 'list', '--format=%gd%x1f%H%x1f%s%x1f%an%x1f%aI']),
    readGitStdout(context.topLevel, ['-c', 'core.quotePath=false', 'log', '--topo-order', '-n', '200', '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%P']),
  ]);
  const upstream = upstreamText || null;
  const divergence = upstream ? await readGitStdout(context.topLevel, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]) : '';
  const [behindText = '0', aheadText = '0'] = divergence.split(/\s+/u);
  const outgoingText = upstream
    ? await readGitStdout(context.topLevel, ['-c', 'core.quotePath=false', 'log', '--topo-order', '-n', '200', '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%P', `${upstream}..HEAD`])
    : '';
  const tags = splitLines(tagsText);
  const recentRefs = await readProjectGitRecentRefs(context.topLevel, reflogText, context, tags);
  return {
    branch: context.branch,
    detached: context.detached,
    headTags: splitLines(headTagsText),
    headSha: context.headSha,
    upstream,
    ahead: Number.parseInt(aheadText, 10) || 0,
    behind: Number.parseInt(behindText, 10) || 0,
    clean: status.clean,
    fileStatuses: status.fileStatuses,
    conflictFiles: status.conflictFiles,
    localBranches: context.localBranches,
    checkedOutBranches: context.worktrees.flatMap((worktree) => (worktree.branch ? [worktree.branch] : [])),
    remoteBranches: context.remoteBranches,
    remotes: context.remotes,
    tags,
    recentRefs,
    recentCommits: parseRecentCommits(recentText),
    outgoingCommits: parseRecentCommits(outgoingText),
    stashes: parseProjectGitStashes(stashText),
    diff,
    stagedDiff: diffSummaryFromText(stagedDiffText),
    unstagedDiff: diffSummaryFromText(unstagedDiffText),
  };
}

/** 执行项目 Git 工作台白名单动作；调用方不能传入任意子命令或任意工作目录。 */
export async function executeProjectGitAction(cwd: string, action: ProjectGitAction): Promise<ProjectGitActionResult> {
  const context = await getGitRepositoryContext(cwd);
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The selected directory is not a Git repository.');
  const repositoryPath = context.topLevel;
  let args: string[];
  switch (action.type) {
    case 'fetch': {
      const remote = requireKnownRemote(context, action.remote);
      args = ['fetch', '--prune', remote];
      break;
    }
    case 'stage':
      args = ['add', '-A', '--', ...requireRepositoryPaths(repositoryPath, action.paths)];
      break;
    case 'unstage':
      args = ['restore', '--staged', '--', ...requireRepositoryPaths(repositoryPath, action.paths)];
      break;
    case 'commit':
      args = ['commit', '-m', requireSafeGitText(action.message, 'commit message')];
      break;
    case 'push': {
      requireNamedCurrentBranch(context);
      const remote = requireKnownRemote(context, action.remote);
      const targetBranch = await assertGitBranchFormat(repositoryPath, action.targetBranch?.trim() || context.branch, 'push target branch');
      const sourceBranch = await assertGitBranchFormat(repositoryPath, context.branch, 'current branch');
      args = ['push', ...(action.forceWithLease ? ['--force-with-lease'] : []), ...(action.pushTags ? ['--follow-tags'] : []), remote, `${sourceBranch}:refs/heads/${targetBranch}`];
      break;
    }
    case 'pull': {
      requireNamedCurrentBranch(context);
      const remote = requireKnownRemote(context, action.remote);
      const targetBranch = await assertGitBranchFormat(repositoryPath, action.targetBranch?.trim() || context.branch, 'pull branch');
      args = ['pull', action.strategy === 'rebase' ? '--rebase' : '--no-rebase', remote, targetBranch];
      break;
    }
    case 'update':
      return finishProjectGitAction(repositoryPath, action.type, await executeProjectGitUpdate(repositoryPath, action.strategy, action.smart === true));
    case 'checkout':
      args = ['switch', await assertGitBranchFormat(repositoryPath, action.branchName, 'branch')];
      break;
    case 'checkout_revision':
      args = ['switch', '--detach', await resolveCommit(repositoryPath, action.revision)];
      break;
    case 'create_branch': {
      const branchName = await assertGitBranchFormat(repositoryPath, action.branchName, 'branch');
      const requestedBase = action.baseRef?.trim() || '';
      const baseRef = requestedBase ? (action.trackRemote ? await assertGitBranchFormat(repositoryPath, requestedBase, 'base branch') : await resolveCommit(repositoryPath, requestedBase)) : null;
      if (action.trackRemote && baseRef) await resolveCommit(repositoryPath, baseRef);
      args = ['switch', '-c', branchName, ...(action.trackRemote ? ['--track'] : []), ...(baseRef ? [baseRef] : [])];
      break;
    }
    case 'delete_branch':
      args = ['branch', '-d', await assertNamedBranchExists(repositoryPath, action.branchName)];
      break;
    case 'merge':
      args = ['merge', '--no-edit', await assertGitBranchFormat(repositoryPath, action.branchName, 'merge branch')];
      break;
    case 'rebase':
      args = ['rebase', await assertGitBranchFormat(repositoryPath, action.branchName, 'rebase branch')];
      break;
    case 'stash':
      args = ['stash', 'push', ...(action.includeUntracked ? ['-u'] : []), '-m', requireSafeGitText(action.message || 'Zeus shelf', 'stash message')];
      break;
    case 'apply_stash':
      args = ['stash', action.pop ? 'pop' : 'apply', requireStashRef(action.stashRef)];
      break;
    case 'drop_stash':
      args = ['stash', 'drop', requireStashRef(action.stashRef)];
      break;
  }
  const conflictCapable = action.type === 'pull' || action.type === 'merge' || action.type === 'rebase' || action.type === 'apply_stash';
  const operation = () => (conflictCapable ? runGitPreservingConflict(repositoryPath, args) : runGit(repositoryPath, args));
  const smart = (action.type === 'checkout' || action.type === 'checkout_revision' || action.type === 'create_branch') && action.smart === true;
  const output = smart ? await runWithSmartStash(repositoryPath, action.type === 'checkout_revision' ? 'Checkout Revision' : 'Checkout', operation) : await operation();
  return finishProjectGitAction(repositoryPath, action.type, output);
}

async function finishProjectGitAction(repositoryPath: string, action: ProjectGitAction['type'], output: GitRunnerResult): Promise<ProjectGitActionResult> {
  const nextContext = await getGitRepositoryContext(repositoryPath);
  const nextStatus = await getGitStatus(repositoryPath);
  return {
    action,
    outcome: nextStatus.conflictFiles.length > 0 ? 'conflict' : 'completed',
    branch: nextContext.branch,
    headSha: nextContext.headSha,
    conflictFiles: nextStatus.conflictFiles,
    ...output,
  };
}

async function executeProjectGitUpdate(repositoryPath: string, strategy: 'merge' | 'rebase' | 'reset', smart: boolean): Promise<GitRunnerResult> {
  const context = await getGitRepositoryContext(repositoryPath);
  requireNamedCurrentBranch(context);
  const upstream = await readGitStdout(repositoryPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!upstream) throw gitCoreError('ZEUS_GIT_UPSTREAM_REQUIRED', `Current branch ${context.branch} does not track a remote branch.`);
  await resolveCommit(repositoryPath, upstream);
  const operation = async (): Promise<GitRunnerResult> => {
    const fetched = await runGit(repositoryPath, ['fetch', '--all', '--prune']);
    const integrated =
      strategy === 'reset'
        ? await runGit(repositoryPath, ['reset', '--hard', upstream])
        : strategy === 'rebase'
          ? await runGitPreservingConflict(repositoryPath, ['rebase', upstream])
          : await runGitPreservingConflict(repositoryPath, ['merge', '--no-edit', upstream]);
    return combineGitRunnerResults(fetched, integrated);
  };
  return smart ? runWithSmartStash(repositoryPath, 'Smart Update', operation) : operation();
}

async function runWithSmartStash(repositoryPath: string, label: string, operation: () => Promise<GitRunnerResult>): Promise<GitRunnerResult> {
  const before = await getGitStatus(repositoryPath);
  if (before.conflictFiles.length > 0) throw gitCoreError('ZEUS_GIT_CONFLICT_IN_PROGRESS', 'Resolve the current Git conflicts before starting another smart operation.');
  if (before.clean) return operation();
  const message = `Zeus ${label} ${new Date().toISOString()}`;
  const saved = await runGit(repositoryPath, ['stash', 'push', '-u', '-m', message]);
  const stashHash = await requireGitStdout(repositoryPath, ['rev-parse', 'refs/stash']);
  let operated: GitRunnerResult;
  try {
    operated = await operation();
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Git operation failed.';
    const operatedStatus = await getGitStatus(repositoryPath).catch(() => emptyGitStatus());
    if (operatedStatus.conflictFiles.length === 0) {
      try {
        const restoration = await restoreSmartStash(repositoryPath, stashHash);
        if (restoration.conflict) return combineGitRunnerResults(saved, restoration.output, { stdout: '', stderr: `${reason} Restoring local changes caused conflicts; stash ${stashHash.slice(0, 8)} was preserved.` });
        throw gitCoreError('ZEUS_GIT_SMART_OPERATION_FAILED', `${reason} Local changes were restored.`);
      } catch (restoreError) {
        if (restoreError instanceof Error && 'code' in restoreError && restoreError.code === 'ZEUS_GIT_SMART_OPERATION_FAILED') throw restoreError;
        const restoreReason = restoreError instanceof Error ? restoreError.message : 'Local changes could not be restored.';
        throw gitCoreError('ZEUS_GIT_SMART_OPERATION_FAILED', `${reason} ${restoreReason} Local changes remain saved in stash ${stashHash.slice(0, 8)}.`);
      }
    }
    throw gitCoreError('ZEUS_GIT_SMART_OPERATION_FAILED', `${reason} Local changes remain saved in stash ${stashHash.slice(0, 8)}.`);
  }
  const operatedStatus = await getGitStatus(repositoryPath);
  if (operatedStatus.conflictFiles.length > 0) {
    return combineGitRunnerResults(saved, operated, {
      stdout: '',
      stderr: `Local changes remain saved in stash ${stashHash.slice(0, 8)} until the update conflict is resolved.`,
    });
  }
  const restoration = await restoreSmartStash(repositoryPath, stashHash);
  if (restoration.conflict) {
    return combineGitRunnerResults(saved, operated, restoration.output, {
      stdout: '',
      stderr: `Restoring local changes caused conflicts. Stash ${stashHash.slice(0, 8)} was preserved.`,
    });
  }
  return combineGitRunnerResults(saved, operated, restoration.output);
}

async function restoreSmartStash(repositoryPath: string, stashHash: string): Promise<{ output: GitRunnerResult; conflict: boolean }> {
  const restored = await runGitPreservingConflict(repositoryPath, ['stash', 'apply', '--index', stashHash]);
  const restoredStatus = await getGitStatus(repositoryPath);
  if (restoredStatus.conflictFiles.length > 0) return { output: restored, conflict: true };
  const stashList = await readGitStdout(repositoryPath, ['stash', 'list', '--format=%gd%x1f%H']);
  const stashRef = splitLines(stashList)
    .map((line) => line.split('\x1f'))
    .find(([, hash]) => hash === stashHash)?.[0];
  let dropped: GitRunnerResult = { stdout: '', stderr: '' };
  if (stashRef) {
    try {
      dropped = await runGit(repositoryPath, ['stash', 'drop', stashRef]);
    } catch (error) {
      dropped = { stdout: '', stderr: `Local changes were restored, but temporary stash ${stashHash.slice(0, 8)} could not be removed: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
  }
  return { output: combineGitRunnerResults(restored, dropped), conflict: false };
}

function combineGitRunnerResults(...results: GitRunnerResult[]): GitRunnerResult {
  return {
    stdout: results
      .map((result) => result.stdout.trim())
      .filter(Boolean)
      .join('\n'),
    stderr: results
      .map((result) => result.stderr.trim())
      .filter(Boolean)
      .join('\n'),
  };
}

function requireNamedCurrentBranch(context: GitRepositoryContext): string {
  if (context.detached) throw gitCoreError('ZEUS_GIT_NAMED_BRANCH_REQUIRED', 'This action requires a current named branch. Create or check out a local branch first.');
  return context.branch;
}

/** 读取一个精确提交的文件和差异，供独立 Repository Diff 与日志检查器复用。 */
export async function getProjectGitCommitDetail(cwd: string, commitHash: string): Promise<ProjectGitCommitDetail> {
  const context = await getGitRepositoryContext(cwd);
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The selected directory is not a Git repository.');
  const commit = await resolveCommit(context.topLevel, commitHash);
  const [metadata, numstat, diffText] = await Promise.all([
    requireGitStdout(context.topLevel, ['-c', 'core.quotePath=false', 'show', '-s', '--date=iso-strict', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%P%x1f%B', commit]),
    readGitStdout(context.topLevel, ['-c', 'core.quotePath=false', 'show', '--format=', '--numstat', commit]),
    readGitStdout(context.topLevel, ['-c', 'core.quotePath=false', 'show', '--format=', '--no-ext-diff', '--find-renames', commit]),
  ]);
  const [hash = commit, shortHash = commit.slice(0, 8), subject = '', author = '', authoredAt = '', parents = '', ...bodyParts] = metadata.split('\x1f');
  const files = splitLines(numstat).flatMap((line) => {
    const [added = '', deleted = '', path = ''] = line.split('\t');
    if (!path) return [];
    return [{ path, additions: added === '-' ? 0 : Number.parseInt(added, 10) || 0, deletions: deleted === '-' ? 0 : Number.parseInt(deleted, 10) || 0 }];
  });
  return {
    commit: { hash, shortHash, subject, author, authoredAt, parentHashes: splitLines(parents.replace(/\s+/gu, '\n')) },
    body: bodyParts.join('\x1f').trim(),
    parentHashes: splitLines(parents.replace(/\s+/gu, '\n')),
    files,
    diff: { isRepository: true, files: files.map((file) => file.path), diffText, fileDiffs: parseGitUnifiedDiff(diffText) },
  };
}

/** 读取所选分支与当前分支或工作区的差异；只解析受 Git 校验的 ref。 */
export async function getProjectGitComparisonDiff(cwd: string, branchName: string, mode: 'current' | 'working-tree'): Promise<GitDiffSummary> {
  const context = await getGitRepositoryContext(cwd);
  if (!context.isRepository) throw gitCoreError('ZEUS_GIT_REPOSITORY_REQUIRED', 'The selected directory is not a Git repository.');
  const branch = await assertGitBranchFormat(context.topLevel, branchName, 'comparison branch');
  const args = mode === 'working-tree' ? ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--find-renames', branch, '--', '.'] : ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--find-renames', `${branch}..HEAD`, '--', '.'];
  return diffSummaryFromText(await readGitStdout(context.topLevel, args));
}

function parseProjectGitStashes(stdout: string): ProjectGitStashEntry[] {
  return splitLines(stdout)
    .map((line) => {
      const [ref = '', hash = '', subject = '', author = '', authoredAt = ''] = line.split('\x1f');
      return { ref, hash, subject, author, authoredAt };
    })
    .filter((entry) => entry.ref.length > 0 && entry.hash.length > 0);
}

async function readProjectGitRecentRefs(cwd: string, reflog: string, context: GitRepositoryContext, tags: string[]): Promise<ProjectGitRecentRef[]> {
  const local = new Set(context.localBranches);
  const remote = new Set(context.remoteBranches);
  const tagSet = new Set(tags);
  const candidates = splitLines(reflog)
    .flatMap((subject) => {
      const match = /^checkout: moving from .+ to (.+)$/u.exec(subject);
      return match?.[1]?.trim() ? [match[1].trim()] : [];
    })
    .filter((ref, index, values) => ref !== context.branch && values.indexOf(ref) === index)
    .slice(0, 12);
  const resolved = await Promise.all(
    candidates.map(async (ref): Promise<ProjectGitRecentRef | null> => {
      const kind: ProjectGitRecentRef['kind'] = local.has(ref) ? 'local' : remote.has(ref) ? 'remote' : tagSet.has(ref) ? 'tag' : 'revision';
      try {
        await resolveCommit(cwd, ref);
        return { ref, kind };
      } catch {
        return null;
      }
    }),
  );
  return resolved.filter((item): item is ProjectGitRecentRef => item !== null);
}

function requireKnownRemote(context: GitRepositoryContext, requested?: string): string {
  const remote = requested?.trim() || (context.remotes.includes('origin') ? 'origin' : context.remotes[0]);
  if (!remote || !context.remotes.includes(remote)) throw gitCoreError('ZEUS_GIT_REMOTE_REQUIRED', 'A configured repository remote is required.');
  return remote;
}

function requireRepositoryPaths(repositoryPath: string, paths: string[]): string[] {
  const normalized = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
  if (normalized.length === 0) throw gitCoreError('ZEUS_GIT_PATH_REQUIRED', 'At least one repository path is required.');
  for (const path of normalized) {
    if (isAbsolute(path) || path.includes('\0')) throw gitCoreError('ZEUS_GIT_PATH_INVALID', `Invalid repository path: ${path}`);
    const target = resolve(repositoryPath, path);
    const targetRelative = relative(repositoryPath, target);
    if (targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) throw gitCoreError('ZEUS_GIT_PATH_INVALID', `Repository path is outside the selected repository: ${path}`);
  }
  return normalized;
}

function requireStashRef(value: string): string {
  const normalized = value.trim();
  if (!/^stash@\{\d+\}$/u.test(normalized)) throw gitCoreError('ZEUS_GIT_STASH_REF_INVALID', `Invalid stash reference: ${normalized}`);
  return normalized;
}

/** 只读获取指定目录此刻所在的 Git 分支，供会话界面展示真实执行现场。 */
export async function getGitWorkingContext(cwd: string): Promise<GitWorkingContext> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    const branch = (await execFileAsync('git', ['branch', '--show-current'], { cwd })).stdout.trim();
    return { isRepository: true, branch: branch || 'detached' };
  } catch {
    return { isRepository: false, branch: null };
  }
}

/** 解析 `git status --porcelain` 输出，提供设计书要求的新增/修改/删除/冲突等只读状态分类。 */
export function parseGitPorcelainStatus(porcelain: string): Pick<GitStatusSummary, 'clean' | 'changedFiles' | 'conflictFiles' | 'fileStatuses'> {
  const fileStatuses = parseGitPorcelainEntries(porcelain);
  const changedFiles = fileStatuses.map((item) => item.path);
  const conflictFiles = fileStatuses.filter((item) => item.category === 'conflict').map((item) => item.path);
  return {
    clean: changedFiles.length === 0,
    changedFiles,
    conflictFiles,
    fileStatuses,
  };
}

function parseGitPorcelainEntries(porcelain: string): GitFileStatus[] {
  if (!porcelain.includes('\0')) {
    return porcelain
      .split(/\r?\n/u)
      .filter((line) => line.length >= 3)
      .map(parseGitPorcelainLine);
  }
  const records = porcelain.split('\0');
  const statuses: GitFileStatus[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (record.length < 3) continue;
    const indexStatus = record[0] ?? ' ';
    const workingTreeStatus = record[1] ?? ' ';
    const path = record.slice(3);
    const renamed = indexStatus === 'R' || indexStatus === 'C' || workingTreeStatus === 'R' || workingTreeStatus === 'C';
    const originalPath = renamed ? records[++index] : undefined;
    statuses.push({
      path,
      ...(originalPath ? { originalPath } : {}),
      indexStatus,
      workingTreeStatus,
      category: classifyGitFileStatus(indexStatus, workingTreeStatus),
    });
  }
  return statuses;
}

function parseGitPorcelainLine(line: string): GitFileStatus {
  const indexStatus = line[0] ?? ' ';
  const workingTreeStatus = line[1] ?? ' ';
  const rawPath = line.slice(3);
  const [originalPath, renamedPath] = rawPath.split(' -> ');
  const path = renamedPath ?? originalPath;
  return {
    path,
    ...(renamedPath ? { originalPath } : {}),
    indexStatus,
    workingTreeStatus,
    category: classifyGitFileStatus(indexStatus, workingTreeStatus),
  };
}

function classifyGitFileStatus(indexStatus: string, workingTreeStatus: string): GitFileStatusCategory {
  const code = `${indexStatus}${workingTreeStatus}`;
  if (indexStatus === '?' && workingTreeStatus === '?') return 'untracked';
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code) || indexStatus === 'U' || workingTreeStatus === 'U') return 'conflict';
  if (indexStatus === 'R' || workingTreeStatus === 'R') return 'renamed';
  if (indexStatus === 'A' || workingTreeStatus === 'A') return 'added';
  if (indexStatus === 'D' || workingTreeStatus === 'D') return 'deleted';
  if (indexStatus === 'M' || workingTreeStatus === 'M') return 'modified';
  return 'other';
}

async function readGitStdout(cwd: string, args: string[]): Promise<string> {
  try {
    return (await execFileAsync('git', args, { cwd })).stdout.trim();
  } catch {
    return '';
  }
}

function parseRecentCommits(stdout: string): GitRecentCommit[] {
  return splitLines(stdout)
    .map((line) => {
      const [hash = '', shortHash = '', subject = '', author = '', authoredAt = '', parents = ''] = line.split('\x1f');
      return { hash, shortHash, subject, author, authoredAt, parentHashes: parents.trim() ? parents.trim().split(/\s+/u) : [] };
    })
    .filter((commit) => commit.hash.length > 0);
}

function emptyGitStatus(): GitStatusSummary {
  return {
    isRepository: false,
    branch: '',
    clean: true,
    changedFiles: [],
    conflictFiles: [],
    fileStatuses: [],
    remoteBranches: [],
    recentCommits: [],
  };
}

/** 只读获取当前工作区 diff；不执行 add、commit、checkout、stash 等写操作。 */
export async function getGitDiff(cwd: string): Promise<GitDiffSummary> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    const names = (await execFileAsync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only'], { cwd })).stdout.trim();
    const stagedNames = (await execFileAsync('git', ['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only'], { cwd })).stdout.trim();
    const porcelain = (await execFileAsync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd })).stdout;
    const untrackedPaths = parseGitPorcelainStatus(porcelain)
      .fileStatuses.filter((file) => file.indexStatus === '?')
      .map((file) => file.path);
    const diffText = (
      await execFileAsync('git', ['-c', 'core.quotePath=false', 'diff', '--', '.'], {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      })
    ).stdout;
    const stagedDiffText = (
      await execFileAsync('git', ['-c', 'core.quotePath=false', 'diff', '--cached', '--', '.'], {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      })
    ).stdout;
    const untrackedDiffs: string[] = [];
    for (const path of untrackedPaths.slice(0, 200)) {
      untrackedDiffs.push(await readGitDiffAllowChanges(cwd, ['-c', 'core.quotePath=false', 'diff', '--no-index', '--', '/dev/null', path]));
    }
    const combinedDiffText = [diffText, stagedDiffText, ...untrackedDiffs].filter(Boolean).join('\n');
    return {
      isRepository: true,
      files: Array.from(new Set([...splitLines(names), ...splitLines(stagedNames), ...untrackedPaths])),
      diffText: combinedDiffText,
      fileDiffs: parseGitUnifiedDiff(combinedDiffText),
    };
  } catch {
    return { isRepository: false, files: [], diffText: '', fileDiffs: [] };
  }
}

/** 将 unified diff 解析成文件、hunk 和行级记录；该函数只解析文本，不执行任何 Git 写操作。 */
export function parseGitUnifiedDiff(diffText: string): GitFileDiff[] {
  const files: GitFileDiff[] = [];
  let currentFile: GitFileDiff | undefined;
  let currentHunk: GitDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      currentFile = createFileDiffFromHeader(line);
      files.push(currentFile);
      currentHunk = undefined;
      continue;
    }
    if (!currentFile) continue;

    if (line.startsWith('rename from ')) {
      currentFile.oldPath = stripDiffPathPrefix(line.slice('rename from '.length));
      currentFile.changeType = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      currentFile.newPath = stripDiffPathPrefix(line.slice('rename to '.length));
      currentFile.changeType = 'renamed';
      continue;
    }
    if (line.startsWith('new file mode ')) {
      currentFile.changeType = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      currentFile.changeType = 'deleted';
      continue;
    }
    if (line.startsWith('copy from ') || line.startsWith('copy to ')) {
      currentFile.changeType = 'copied';
      continue;
    }
    if (line.startsWith('--- ')) {
      const path = parseDiffMarkerPath(line.slice(4));
      if (path && path !== '/dev/null') currentFile.oldPath = path;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = parseDiffMarkerPath(line.slice(4));
      if (path && path !== '/dev/null') currentFile.newPath = path;
      if (path === '/dev/null') currentFile.changeType = 'deleted';
      continue;
    }
    if (line.startsWith('@@ ')) {
      currentHunk = parseGitDiffHunkHeader(line);
      currentFile.hunks.push(currentHunk);
      oldLine = currentHunk.oldStart;
      newLine = currentHunk.newStart;
      continue;
    }
    if (!currentHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentHunk.lines.push({
        type: 'addition',
        content: line.slice(1),
        oldLineNumber: null,
        newLineNumber: newLine,
      });
      currentFile.addedLines += 1;
      newLine += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      currentHunk.lines.push({
        type: 'deletion',
        content: line.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: null,
      });
      currentFile.deletedLines += 1;
      oldLine += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      currentHunk.lines.push({
        type: 'context',
        content: line.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (line.startsWith('\\')) {
      currentHunk.lines.push({
        type: 'metadata',
        content: line,
        oldLineNumber: null,
        newLineNumber: null,
      });
    }
  }

  return files;
}

function createFileDiffFromHeader(header: string): GitFileDiff {
  const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(header);
  return {
    oldPath: match?.[1] ?? '',
    newPath: match?.[2] ?? '',
    changeType: 'modified',
    addedLines: 0,
    deletedLines: 0,
    hunks: [],
  };
}

function parseGitDiffHunkHeader(header: string): GitDiffHunk {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(header);
  return {
    header,
    oldStart: Number(match?.[1] ?? 0),
    oldLines: Number(match?.[2] ?? 1),
    newStart: Number(match?.[3] ?? 0),
    newLines: Number(match?.[4] ?? 1),
    lines: [],
  };
}

function parseDiffMarkerPath(value: string): string {
  return value === '/dev/null' ? value : stripDiffPathPrefix(value);
}

function stripDiffPathPrefix(value: string): string {
  return value.replace(/^[ab]\//u, '');
}

/** 基于只读 diff 构造 patch 导出负载；不执行任何 Git 写操作。 */
export function buildGitPatchExport(diff: GitDiffSummary, createdAt = new Date().toISOString()): GitPatchExport {
  const timestamp = createdAt.replace(/[^0-9A-Za-z]/g, '-');
  return {
    fileName: `zeus-diff-${timestamp}.patch`,
    mimeType: 'text/x-patch',
    patchText: diff.diffText,
    files: diff.files,
    createdAt,
  };
}

function splitLines(value: string): string[] {
  return value ? value.split('\n').filter(Boolean) : [];
}

function splitNullRecords(value: string): string[] {
  return value
    .split('\0')
    .map((item) => item.trim())
    .filter(Boolean);
}
