import type { ProjectSourceDirectorySnapshot, ProjectSourceWorktree } from '@zeus/shared';
import { ExternalStore } from '../externalStore.js';

/** 已读目录的相对路径以工作树根目录为起点。 */
type Directories = Record<string, ProjectSourceDirectorySnapshot>;

/** 每份快照绑定窗口内的源码身份；被移除的实例拒绝迟到的目录读取结果。 */
class SourceTree extends ExternalStore<Directories | null> {
  /** 上次显示时的展开位置与目录快照一起恢复。 */
  expandedDirectories?: Set<string>;

  /** 业务项目用于限定刷新范围，源码身份用于主进程核对真实根目录。 */
  constructor(
    readonly ownerProjectId: string,
    readonly projectId: string,
    readonly root: string,
  ) {
    super({});
  }

  /** 主进程返回的真实路径可匹配通过符号链接打开的项目。 */
  get worktreeRoot(): string {
    return this.snapshot?.['']?.worktreeRoot ?? this.root;
  }

  /** 保留用户正在查看的树，只有快照变化时才通知文件树重绘。 */
  readonly setDirectories = (update: (current: Directories) => Directories): void => {
    if (!this.snapshot) return;
    const next = update(this.snapshot);
    if (next !== this.snapshot) this.publish(next);
  };

  /** 通知正在显示的文件树清空目录，并释放缓存引用。 */
  remove(): void {
    this.expandedDirectories = undefined;
    this.publish(null);
  }
}

/** 窗口内同一源码身份和根目录共用一份快照。 */
const trees = new Map<string, SourceTree>();

/** 首次读取从空树开始，切回仍存在的工作树直接复用快照。 */
export function projectSourceTree(ownerProjectId: string, projectId: string, root: string): SourceTree {
  const key = JSON.stringify([projectId, root]);
  const existing = trees.get(key);
  if (existing) return existing;
  const tree = new SourceTree(ownerProjectId, projectId, root);
  trees.set(key, tree);
  return tree;
}

/** 只移除原快照实例，避免过期的刷新回执清除同路径重建的工作树。 */
function forgetSourceTree(tree: SourceTree): void {
  const key = JSON.stringify([tree.projectId, tree.root]);
  if (trees.get(key) !== tree) return;
  trees.delete(key);
  tree.remove();
}

/** Core 删除成功后，同一磁盘根目录在本窗口的快照一起失效。 */
export function forgetRemovedSourceWorktree(root: string): void {
  for (const tree of trees.values()) {
    if (tree.worktreeRoot === root) forgetSourceTree(tree);
  }
}

/** 选择器未列出的目录可能只是预览工作区，只有主进程确认目录消失才释放。 */
export async function refreshMissingSourceTrees(ownerProjectId: string, worktrees: ProjectSourceWorktree[]): Promise<void> {
  const listedRoots = new Set(worktrees.map((worktree) => worktree.localPath));
  const candidates = [...trees.values()].filter((tree) => tree.ownerProjectId === ownerProjectId && !listedRoots.has(tree.worktreeRoot));
  if (!candidates.length || !window.zeus) return;
  /** IPC 未确认时保留所有候选，后续清单刷新会再次核对。 */
  const missing = new Set(
    await window.zeus
      .findMissingProjectSourceWorktrees(
        ownerProjectId,
        candidates.map((tree) => tree.projectId),
      )
      .catch((): string[] => []),
  );
  for (const tree of candidates) {
    if (missing.has(tree.root)) forgetSourceTree(tree);
  }
}
