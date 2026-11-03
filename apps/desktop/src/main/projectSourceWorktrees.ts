import { discoverGitRepositories, getGitCommonDirectory, getGitRepositoryContext } from '@zeus/git-core';
import type { ProjectSourceWorktree } from '@zeus/shared';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectGitProjectIdentity } from './projectGitWorkbench.js';

/** 只查询项目内仓库的 Git 登记，不从目录名推断工作树，也不创建或检出分支。 */
export async function listProjectSourceWorktrees(project: ProjectGitProjectIdentity): Promise<ProjectSourceWorktree[]> {
  /** 项目入口始终回到同一个真实项目目录。 */
  const root = await realpath(project.localPath);
  /** Git 的公共目录去重规则与项目工作台一致。 */
  const repositories = await discoverGitRepositories(root);
  /** 项目目录先出现，额外工作树按所属仓库顺序追加。 */
  const choices: ProjectSourceWorktree[] = [{ id: 'project', kind: 'project', repositoryName: '', branch: null, headSha: '', localPath: root }];
  /** 同一个目录只提供一个入口，避免嵌套发现导致重复。 */
  const seen = new Set([root]);
  for (const repository of repositories) {
    /** 路径别名在比较前统一，Windows 与 macOS 使用同一真实目录身份。 */
    const repositoryRoot = await realpath(repository.localPath);
    /** 来源仓库提供当前真实 worktree 清单。 */
    const context = await getGitRepositoryContext(repository.localPath);
    if (!context.isRepository) continue;
    /** 目录归属使用 Git 公共目录身份核对。 */
    const commonDirectory = await getGitCommonDirectory(repository.localPath);
    for (const worktree of context.worktrees) {
      if (worktree.bare || worktree.prunable) continue;
      /** 已被删除但尚未 prune 的目录不作为可切换项。 */
      const localPath = await realpath(worktree.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      });
      if (!localPath || seen.has(localPath) || localPath === repositoryRoot) continue;
      /** 防止 .git 丢失后 Git 向上找到父仓，从而把普通目录当成工作树。 */
      const marker = await lstat(join(localPath, '.git')).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      });
      if (!marker || (!marker.isFile() && !marker.isDirectory())) continue;
      /** Git 标记丢失或指向其他仓库时保留原文件，不授予源码目录身份。 */
      if ((await getGitCommonDirectory(localPath)) !== commonDirectory) continue;
      seen.add(localPath);
      choices.push({
        id: createHash('sha256').update(`${project.id}\0${commonDirectory}\0${localPath}`).digest('hex'),
        kind: 'worktree',
        repositoryName: repository.relativePath === '.' ? repository.name : repository.relativePath,
        branch: worktree.branch,
        headSha: worktree.headSha,
        localPath,
      });
    }
  }
  return choices;
}
