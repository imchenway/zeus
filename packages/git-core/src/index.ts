import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
  if (normalized.includes('\0') || normalized.includes('\n') || normalized.includes('\r')) throw new Error(`Git ${label} contains unsafe characters`);
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

async function defaultGitCommandRunner(cwd: string, args: string[]): Promise<GitRunnerResult> {
  const result = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

/** 只读获取 Git 状态，不执行提交、回退、合并等高风险写操作。 */
export async function getGitStatus(cwd: string): Promise<GitStatusSummary> {
  try {
    const branch = (await execFileAsync('git', ['branch', '--show-current'], { cwd })).stdout.trim() || 'detached';
    const porcelain = (await execFileAsync('git', ['status', '--porcelain'], { cwd })).stdout.trim();
    const parsedStatus = parseGitPorcelainStatus(porcelain);
    const remoteBranches = splitLines(await readGitStdout(cwd, ['branch', '-r', '--format=%(refname:short)']));
    const recentCommits = parseRecentCommits(await readGitStdout(cwd, ['log', '-n', '5', '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI']));
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

/** 解析 `git status --porcelain` 输出，提供设计书要求的新增/修改/删除/冲突等只读状态分类。 */
export function parseGitPorcelainStatus(porcelain: string): Pick<GitStatusSummary, 'clean' | 'changedFiles' | 'conflictFiles' | 'fileStatuses'> {
  const fileStatuses = splitLines(porcelain).map(parseGitPorcelainLine);
  const changedFiles = fileStatuses.map((item) => item.path);
  const conflictFiles = fileStatuses.filter((item) => item.category === 'conflict').map((item) => item.path);
  return {
    clean: changedFiles.length === 0,
    changedFiles,
    conflictFiles,
    fileStatuses,
  };
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
      const [hash = '', shortHash = '', subject = '', author = '', authoredAt = ''] = line.split('\x1f');
      return { hash, shortHash, subject, author, authoredAt };
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
    const names = (await execFileAsync('git', ['diff', '--name-only'], { cwd })).stdout.trim();
    const stagedNames = (await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd })).stdout.trim();
    const diffText = (
      await execFileAsync('git', ['diff', '--', '.'], {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      })
    ).stdout;
    const stagedDiffText = (
      await execFileAsync('git', ['diff', '--cached', '--', '.'], {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      })
    ).stdout;
    const combinedDiffText = [diffText, stagedDiffText].filter(Boolean).join('\n');
    return {
      isRepository: true,
      files: Array.from(new Set([...splitLines(names), ...splitLines(stagedNames)])),
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
