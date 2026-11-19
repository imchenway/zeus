import type { ProjectGitBranchRepository } from '@zeus/git-core';
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
export function intersectRepositoryValues<Repository extends ProjectGitBranchRepository>(repositories: readonly Repository[], read: (repository: Repository) => string[]): string[] {
  if (repositories.length === 0) return [];
  /** 第一仓提供候选，其余仓库确认引用存在。 */
  const [first, ...rest] = repositories;
  /** 每个仓库只取一次引用，避免批量列表随分支数量重复扫描。 */
  const remaining = rest.map((repository) => new Set(read(repository)));
  return [...new Set(read(first!))].filter((value) => remaining.every((values) => values.has(value))).sort((left, right) => left.localeCompare(right));
}

/** 只有 HEAD 时可用当前本地分支；首次提交前也允许创建工作树。 */
export function repositoryLocalBranches(repository: Pick<ProjectGitBranchRepository, 'snapshot'>): string[] {
  const snapshot = repository.snapshot;
  const local = snapshot.localBranches ?? [];
  return !snapshot.detached && (!snapshot.localBranches || !snapshot.headSha) && snapshot.branch && !local.includes(snapshot.branch) ? [snapshot.branch, ...local] : local;
}

/** 父仓库已在签出范围内时，子模块由父仓库同步；单独选择子模块仍可切换其开发分支。 */
export function branchSwitchRepositories<Repository extends ProjectGitBranchRepository>(repositories: readonly Repository[]): Repository[] {
  /** 只排除已登记的子模块，保留目录嵌套的独立仓库。 */
  const submodulePaths = new Set(repositories.flatMap((repository) => (repository.snapshot.submodules ?? []).map(({ path }) => (repository.relativePath && repository.relativePath !== '.' ? `${repository.relativePath}/${path}` : path))));
  return repositories.filter((repository) => !submodulePaths.has(repository.relativePath));
}

/** 多仓动作按顺序执行；失败或冲突后保留已完成结果，不继续处理剩余仓库。 */
export async function executeRepositoryBatch<Repository extends ProjectGitBranchRepository>(repositories: readonly Repository[], execute: (repository: Repository) => Promise<ExecutionOutcome>) {
  /** 已成功成员用于准确显示部分完成，不能据此自动反向切换分支。 */
  const completed: Repository[] = [];
  for (const repository of repositories) {
    /** 调用方保留具体 Git 错误和冲突处理入口。 */
    const outcome = await execute(repository);
    if (outcome !== 'completed') return { completed, stopped: repository, remaining: repositories.slice(completed.length + 1) };
    completed.push(repository);
  }
  return { completed, stopped: null, remaining: [] };
}
