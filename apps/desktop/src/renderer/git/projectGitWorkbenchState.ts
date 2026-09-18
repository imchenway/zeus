import type { GitFileStatusSummary, ProjectGitRepositoryWorkbenchItem, ProjectGitWorkbenchSnapshot } from '../apiClient.js';

export interface ProjectGitQueryClient {
  loadProjectGitWorkbench(projectId: string): Promise<ProjectGitWorkbenchSnapshot>;
}

interface ProjectGitWorkbenchCacheEntry {
  snapshot: ProjectGitWorkbenchSnapshot | null;
  request: Promise<ProjectGitWorkbenchSnapshot> | null;
}

const projectGitWorkbenchCacheLimit = 3;
const projectGitWorkbenchCache = new WeakMap<ProjectGitQueryClient, Map<string, ProjectGitWorkbenchCacheEntry>>();

export function projectGitWorkbenchCacheEntry(client: ProjectGitQueryClient, projectId: string): ProjectGitWorkbenchCacheEntry {
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
  const created: ProjectGitWorkbenchCacheEntry = { snapshot: null, request: null };
  projectCache.set(projectId, created);
  // ponytail: 只保留最近 3 个项目；实测多项目往返仍冷加载时再改为按字节预算淘汰。
  const oldestProjectId = projectCache.keys().next().value;
  if (projectCache.size > projectGitWorkbenchCacheLimit && oldestProjectId) projectCache.delete(oldestProjectId);
  return created;
}

export function readCachedProjectGitWorkbench(client: ProjectGitQueryClient, projectId: string): ProjectGitWorkbenchSnapshot | null {
  return projectGitWorkbenchCacheEntry(client, projectId).snapshot;
}

export function requestProjectGitWorkbench(client: ProjectGitQueryClient, projectId: string): Promise<ProjectGitWorkbenchSnapshot> {
  const entry = projectGitWorkbenchCacheEntry(client, projectId);
  if (entry.request) return entry.request;
  const request = client
    .loadProjectGitWorkbench(projectId)
    .then((snapshot) => {
      if (entry.request === request) entry.snapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      if (entry.request === request) entry.request = null;
    });
  entry.request = request;
  return request;
}

/** 两个工作入口共享失效通知；外部文件变更按短窗口合并，避免频繁闪空列表。 */
export function subscribeProjectGitRefresh(projectId: string, refresh: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 250);
  };
  const changed = (event: Event) => {
    if ((event as CustomEvent<string>).detail === projectId) schedule();
  };
  const unsubscribe = window.zeus?.onProjectSourceEvent?.((event) => {
    if (event.projectId === projectId) schedule();
  });
  window.addEventListener('focus', schedule);
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('zeus:git-workbench-changed', changed);
  return () => {
    clearTimeout(timer);
    unsubscribe?.();
    window.removeEventListener('focus', schedule);
    document.removeEventListener('visibilitychange', schedule);
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
