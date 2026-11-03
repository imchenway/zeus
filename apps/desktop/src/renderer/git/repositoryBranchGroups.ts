import type { ProjectGitRepositoryWorkbenchItem } from '../apiClient.js';
import type { ExecutionOutcome } from './gitWorkbenchTypes.js';

/** 交付文件树和分支范围选择共用分组顺序，不重新排列仓库。 */
export function groupRepositoriesByBranch<T>(repositories: readonly T[], readBranch: (repository: T) => string): Array<{ branchName: string; repositories: T[] }> {
  /** 分支名是组身份，仓库身份仍保留在成员中。 */
  const groups = new Map<string, T[]>();
  for (const repository of repositories) {
    /** 同名分支合为一个可操作范围。 */
    const branchName = readBranch(repository);
    /** 保持首次出现的分支和仓库顺序。 */
    const members = groups.get(branchName);
    if (members) members.push(repository);
    else groups.set(branchName, [repository]);
  }
  return [...groups].map(([branchName, members]) => ({ branchName, repositories: members }));
}

/** Git 菜单和会话入口只把全部所选仓库都拥有的引用作为批量目标。 */
export function intersectRepositoryValues(repositories: readonly ProjectGitRepositoryWorkbenchItem[], read: (repository: ProjectGitRepositoryWorkbenchItem) => string[]): string[] {
  if (repositories.length === 0) return [];
  /** 第一仓提供候选，其余仓库确认引用存在。 */
  const [first, ...rest] = repositories;
  return [...new Set(read(first!))].filter((value) => rest.every((repository) => read(repository).includes(value))).sort((left, right) => left.localeCompare(right));
}

/** 尚无首次提交的当前分支没有 refs/heads，但仍可作为工作树来源。 */
export function repositoryLocalBranches(repository: Pick<ProjectGitRepositoryWorkbenchItem, 'snapshot'>): string[] {
  /** 当前分支与已存在引用都来自同一仓库快照。 */
  const snapshot = repository.snapshot;
  return !snapshot.detached && !snapshot.headSha && snapshot.branch && !snapshot.localBranches.includes(snapshot.branch) ? [snapshot.branch, ...snapshot.localBranches] : snapshot.localBranches;
}

/** 多仓动作按顺序执行；失败或冲突后保留已完成结果，不继续处理剩余仓库。 */
export async function executeRepositoryBatch(repositories: readonly ProjectGitRepositoryWorkbenchItem[], execute: (repository: ProjectGitRepositoryWorkbenchItem) => Promise<ExecutionOutcome>) {
  /** 已成功成员用于准确显示部分完成，不能据此自动反向切换分支。 */
  const completed: ProjectGitRepositoryWorkbenchItem[] = [];
  for (const repository of repositories) {
    /** 调用方保留具体 Git 错误和冲突处理入口。 */
    const outcome = await execute(repository);
    if (outcome !== 'completed') return { completed, stopped: repository, remaining: repositories.slice(completed.length + 1) };
    completed.push(repository);
  }
  return { completed, stopped: null, remaining: [] };
}
