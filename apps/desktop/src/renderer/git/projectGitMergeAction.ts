import type { ProjectGitAction, ProjectGitRepositoryWorkbenchItem } from '../features/git/gitContracts.js';

/** 固定界面展示的目标分支与 HEAD，让各合并入口共用同一快照约束。 */
export function createProjectGitMergeAction(repository: ProjectGitRepositoryWorkbenchItem, branchName: string): Extract<ProjectGitAction, { type: 'merge' }> {
  return {
    type: 'merge',
    branchName,
    expectedBranch: repository.snapshot.branch,
    expectedHeadSha: repository.snapshot.headSha,
  };
}
