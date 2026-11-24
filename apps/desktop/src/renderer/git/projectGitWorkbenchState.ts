import type { GitFileStatusSummary, ProjectGitRepositoryWorkbenchItem, ProjectGitWorkbenchSnapshot } from '../apiClient.js';
import type { ProjectGitBranchSelection } from '@zeus/git-core';
import { CachedQuery } from '../cachedQuery.js';

/** 工作台只展示可核验的仓库，提示被跳过的相对路径和交付限制。 */
export function unavailableGitRepositoriesNotice(snapshot: ProjectGitWorkbenchSnapshot | null, zh: boolean): string | null {
  const names = snapshot?.unavailableRepositories?.join(zh ? '、' : ', ');
  if (!names) return null;
  return zh ? `工作树已失效（${names}）。可查看其余仓库，交付前需修复这些工作树。` : `Worktrees unavailable (${names}). You can view the other repositories. Restore these worktrees before delivery.`;
}

/** 源码与搜索共用项目相对路径，拒绝将上一项目的快照套到当前项目。 */
export function projectGitFileStatuses(snapshot: ProjectGitWorkbenchSnapshot | null | undefined, projectId: string): Record<string, GitFileStatusSummary['category']> {
  if (snapshot?.projectId !== projectId) return {};
  return Object.fromEntries(
    snapshot.repositories.flatMap((repository) =>
      visibleRepositoryFiles(repository, snapshot.repositories).map((file) => [[repository.relativePath === '.' ? '' : repository.relativePath, file.path].filter(Boolean).join('/'), file.category]),
    ),
  );
}

export interface ProjectGitQueryClient {
  loadProjectGitWorkbench(projectId: string, includePatches?: boolean): Promise<ProjectGitWorkbenchSnapshot>;
  /** 会话读取 HEAD 和候选列表时使用同一项目身份。 */
  loadProjectGitBranches?(projectId: string, includeReferences: boolean): Promise<ProjectGitBranchSelection>;
}

/** Git 快照与普通只读查询共用过期、在途去重和迟到回执规则。 */
type ProjectGitWorkbenchCacheEntry = CachedQuery<ProjectGitWorkbenchSnapshot>;

/** 分支首读与展开读取共用项目缓存边界，各自保留在途请求。 */
interface ProjectGitQueryEntries {
  workbench: ProjectGitWorkbenchCacheEntry;
  heads: CachedQuery<ProjectGitBranchSelection> | null;
  references: CachedQuery<ProjectGitBranchSelection> | null;
}

/** 保留最近读取的项目数量。 */
const projectGitWorkbenchCacheLimit = 3;
/** 不同客户端实例的项目快照互相隔离。 */
const projectGitWorkbenchCache = new WeakMap<ProjectGitQueryClient, Map<string, ProjectGitQueryEntries>>();

/** 为一个项目取得工作台、HEAD 和引用清单的缓存。 */
export function projectGitQueryEntries(client: ProjectGitQueryClient, projectId: string): ProjectGitQueryEntries {
  let projectCache = projectGitWorkbenchCache.get(client);
  if (!projectCache) {
    projectCache = new Map();
    projectGitWorkbenchCache.set(client, projectCache);
  }
  const current = projectCache.get(projectId);
  if (current) {
    projectCache.delete(projectId);
    projectCache.set(projectId, current);
    return current;
  }
  /** 当前桌面主进程提供只读分支查询；工作台入口可以独立工作。 */
  const loadBranches = client.loadProjectGitBranches?.bind(client, projectId);
  const created = {
    workbench: new CachedQuery(() => client.loadProjectGitWorkbench(projectId, false), 2_000),
    heads: loadBranches ? new CachedQuery(() => loadBranches(false), 2_000) : null,
    references: loadBranches ? new CachedQuery(() => loadBranches(true), 2_000) : null,
  };
  projectCache.set(projectId, created);
  // ponytail: 只保留最近 3 个项目；实测多项目往返仍冷加载时再改为按字节预算淘汰。
  const oldestProjectId = projectCache.keys().next().value;
  if (projectCache.size > projectGitWorkbenchCacheLimit && oldestProjectId) projectCache.delete(oldestProjectId);
  return created;
}

/** 工作台消费者仍订阅完整的文件与提交快照。 */
export function projectGitWorkbenchCacheEntry(client: ProjectGitQueryClient, projectId: string): ProjectGitWorkbenchCacheEntry {
  return projectGitQueryEntries(client, projectId).workbench;
}

export function readCachedProjectGitWorkbench(client: ProjectGitQueryClient, projectId: string): ProjectGitWorkbenchSnapshot | null {
  return projectGitWorkbenchCacheEntry(client, projectId).getSnapshot().value;
}

export function requestProjectGitWorkbench(client: ProjectGitQueryClient, projectId: string, force = false): Promise<ProjectGitWorkbenchSnapshot> {
  const entry = projectGitWorkbenchCacheEntry(client, projectId);
  if (force) entry.invalidate();
  return entry.load(force);
}

/** 两个工作入口共享失效通知；外部文件变更按短窗口合并，避免频繁闪空列表。 */
export function subscribeProjectGitRefresh(projectId: string, refresh: (force?: boolean) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  const schedule = (force = false) => {
    dirty ||= force;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.visibilityState === 'visible') {
        const force = dirty;
        dirty = false;
        refresh(force);
      }
    }, 250);
  };
  const changed = (event: Event) => {
    if ((event as CustomEvent<string>).detail === projectId) schedule(true);
  };
  const unsubscribe = window.zeus?.onProjectSourceEvent?.((event) => {
    if (event.projectId === projectId) schedule(true);
  });
  const wake = () => schedule();
  window.addEventListener('focus', wake);
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('zeus:git-workbench-changed', changed);
  return () => {
    clearTimeout(timer);
    unsubscribe?.();
    window.removeEventListener('focus', wake);
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('zeus:git-workbench-changed', changed);
  };
}

export function notifyProjectGitChanged(projectId: string): void {
  window.dispatchEvent(new CustomEvent('zeus:git-workbench-changed', { detail: projectId }));
}

/** 已识别的嵌套仓库由自己的分组管理，不把目录占位项作为父仓库的新文件。 */
export function visibleRepositoryFiles(repository: ProjectGitRepositoryWorkbenchItem, repositories: ProjectGitRepositoryWorkbenchItem[]): GitFileStatusSummary[] {
  const nestedPaths = new Set(repositories.filter((item) => item.id !== repository.id).map((item) => item.relativePath));
  return repository.snapshot.fileStatuses.filter((file) => {
    if (file.indexStatus !== '?' || !file.path.endsWith('/')) return true;
    const path = [repository.relativePath === '.' ? '' : repository.relativePath, file.path.replace(/\/$/, '')].filter(Boolean).join('/');
    return !nestedPaths.has(path);
  });
}
