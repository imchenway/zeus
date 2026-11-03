import type { ProjectGitAction } from '../apiClient.js';

export type BusyState = { repositoryId: string; action: ProjectGitAction['type'] } | null;

export type OperationTone = 'success' | 'warning' | 'error';

export type BranchKind = 'local' | 'remote';

export type ExecutionOutcome = 'completed' | 'conflict' | null;

/** 更新项目提供保留本地提交的合并和变基策略。 */
export type ProjectGitUpdateStrategy = 'merge' | 'rebase';

export type PushSelection = { repositoryId: string; remote: string; sourceBranch: string; targetBranch: string; setUpstream: boolean };
