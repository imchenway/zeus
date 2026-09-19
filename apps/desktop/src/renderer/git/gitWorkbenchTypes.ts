import type { ProjectGitAction } from '../apiClient.js';

export type BusyState = { repositoryId: string; action: ProjectGitAction['type'] } | null;

export type OperationTone = 'success' | 'warning' | 'error';

export type BranchKind = 'local' | 'remote';

export type ExecutionOutcome = 'completed' | 'conflict' | null;

export type ProjectGitUpdateStrategy = 'merge' | 'rebase' | 'reset';

export type PushSelection = { repositoryId: string; remote: string; sourceBranch: string; targetBranch: string; setUpstream: boolean };
