import type { ProjectGitAction } from '../apiClient.js';

export type BusyState = { repositoryId: string; action: ProjectGitAction['type'] } | null;

export type OperationTone = 'success' | 'warning' | 'error';

export type BranchKind = 'local' | 'remote';

/** 文件编辑区使用项目仓库及完整引用标识一张分支对比标签。 */
export interface GitBranchComparisonTarget {
  id: string;
  projectId: string;
  repositoryId: string;
  repositoryName: string;
  branch: string;
  ref: string;
}

/** 历史目录只在固定提交及其所属 Git 根中浏览。 */
export interface GitRepositoryRevisionTarget {
  id: string;
  projectId: string;
  repositoryId: string;
  repositoryName: string;
  revision: string;
}

/** 项目源码页为 Compare 和历史目录共用编辑器标签。 */
export type GitSourceEditorTarget = GitBranchComparisonTarget | GitRepositoryRevisionTarget;

/** 对比复用 Git 工作台的操作，内容挂载到文件编辑区为它分配的节点。 */
export interface GitBranchComparisonEditor {
  target: GitBranchComparisonTarget;
  host: HTMLDivElement;
}

export type ExecutionOutcome = 'completed' | 'conflict' | null;

/** 更新项目提供保留本地提交的合并和变基策略。 */
export type ProjectGitUpdateStrategy = 'merge' | 'rebase';

export type PushSelection = { repositoryId: string; remote: string; sourceBranch: string; targetBranch: string; setUpstream: boolean; /** 分支历史中的固定来源提交。 */ sourceRevision?: string };
