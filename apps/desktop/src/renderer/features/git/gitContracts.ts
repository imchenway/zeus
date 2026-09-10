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

export interface ProjectGitSnapshotResult {
  projectId: string;
  taskId: string;
  snapshotType: 'readonly_diff';
  isRepository: boolean;
  fileCount: number;
  diffTextLength: number;
}

export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authoredAt: string;
  parentHashes: string[];
}

export interface GitFileStatusSummary {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workingTreeStatus: string;
  category: string;
}

export interface GitStatusSummary {
  isRepository: boolean;
  branch: string;
  clean?: boolean;
  changedFiles: string[];
  conflictFiles?: string[];
  fileStatuses?: GitFileStatusSummary[];
  remoteBranches?: string[];
  recentCommits?: GitCommitSummary[];
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
  submodules?: { path: string; initialized: boolean }[];
  branch: string;
  detached: boolean;
  headTags: string[];
  headSha: string;
  upstream: string | null;
  integrationState?: 'merge' | 'rebase' | null;
  ahead: number;
  behind: number;
  clean: boolean;
  fileStatuses: NonNullable<GitStatusSummary['fileStatuses']>;
  conflictFiles: string[];
  localBranches: string[];
  /** 同一 Git 仓库中已经由任一 worktree 检出的本地分支；混合版本宿主缺失时按空集合降级。 */
  checkedOutBranches?: string[];
  remoteBranches: string[];
  remotes: string[];
  tags: string[];
  recentRefs: ProjectGitRecentRef[];
  recentCommits: NonNullable<GitStatusSummary['recentCommits']>;
  outgoingCommits: NonNullable<GitStatusSummary['recentCommits']>;
  stashes: ProjectGitStashEntry[];
  diff: GitDiffSummary;
  stagedDiff: GitDiffSummary;
  unstagedDiff: GitDiffSummary;
}

export interface ProjectGitRepositoryWorkbenchItem {
  id: string;
  name: string;
  relativePath: string;
  isSubmodule?: boolean;
  subtreePaths?: string[];
  snapshot: ProjectGitRepositorySnapshot;
}

/** 桌面操作历史共用 Git 公共契约，避免桥接两端各自定义状态。 */
export type { ProjectGitOperationPage, ProjectGitOperationRecord } from '@zeus/git-core';

export interface ProjectGitWorkbenchSnapshot {
  projectId: string;
  projectName: string;
  refreshedAt: string;
  repositories: ProjectGitRepositoryWorkbenchItem[];
}

export type ProjectGitAction =
  | { type: 'discard'; paths: string[] }
  | { type: 'rename_branch'; branchName: string; newName: string }
  | { type: 'create_tag'; tagName: string; revision: string; message?: string }
  | { type: 'push_tag'; tagName: string; remote: string }
  | { type: 'delete_tag'; tagName: string }
  | { type: 'subtree'; operation: 'add' | 'pull' | 'push'; path: string; remote: string; branch: string }
  | { type: 'submodule_update'; path: string }
  | { type: 'fetch'; remote?: string }
  | { type: 'stage'; paths: string[] }
  | { type: 'unstage'; paths: string[] }
  | { type: 'apply_patch'; patch: string; reverse?: boolean }
  | { type: 'commit'; message: string }
  | { type: 'push'; remote?: string; targetBranch?: string; forceWithLease?: boolean; pushTags?: boolean }
  | { type: 'pull'; remote?: string; targetBranch?: string; strategy: 'rebase' | 'merge' }
  | { type: 'update'; strategy: 'merge' | 'rebase' | 'reset'; smart?: boolean }
  | { type: 'checkout'; branchName: string; smart?: boolean }
  | { type: 'checkout_revision'; revision: string; smart?: boolean }
  | { type: 'create_branch'; branchName: string; baseRef?: string; trackRemote?: boolean; smart?: boolean }
  | { type: 'delete_branch'; branchName: string }
  | { type: 'revert'; revision: string }
  | { type: 'cherry_pick'; revision: string }
  | { type: 'merge'; branchName: string }
  | { type: 'rebase'; branchName: string }
  | { type: 'stash'; message?: string; includeUntracked?: boolean }
  | { type: 'apply_stash'; stashRef: string; pop?: boolean }
  | { type: 'drop_stash'; stashRef: string }
  | { type: 'continue_integration' | 'abort_integration'; kind: 'merge' | 'rebase' };

export interface ProjectGitActionResponse {
  projectId: string;
  repositoryId: string;
  repositoryName: string;
  result: {
    action: ProjectGitAction['type'];
    outcome: 'completed' | 'conflict';
    branch: string;
    headSha: string;
    conflictFiles: string[];
    stdout: string;
    stderr: string;
  };
  snapshot: ProjectGitRepositorySnapshot;
}

export interface ProjectGitCommitDetail {
  commit: NonNullable<GitStatusSummary['recentCommits']>[number];
  body: string;
  parentHashes: string[];
  files: Array<{ path: string; additions: number; deletions: number }>;
  diff: GitDiffSummary;
}

export type HighRiskGitOperation = 'commit' | 'stash' | 'apply_stash' | 'rollback' | 'branch' | 'switch_branch' | 'pull' | 'push';

export interface GitOperationConfirmation {
  id: string;
  operation: HighRiskGitOperation;
  cwd: string;
  reason: string;
  message?: string;
  status: 'pending' | 'confirmed' | 'rejected';
  riskLevel: 'high';
  confirmationText: string;
  createdAt: string;
  expiresAt: string;
  confirmedAt?: string;
  rejectedAt?: string;
  rejectedReason?: string;
}

export interface CreateGitConfirmationRequest {
  operation: HighRiskGitOperation;
  reason: string;
  message?: string;
}

export interface ExecuteGitOperationRequest {
  confirmationId: string;
  operation: HighRiskGitOperation;
  message?: string;
  branchName?: string;
  baseRef?: string;
  stashRef?: string;
  remote?: string;
  targetRef?: string;
}

export interface ExecutedGitOperationResult {
  operation: HighRiskGitOperation;
  cwd: string;
  args: string[];
  stdout: string;
  stderr: string;
}
