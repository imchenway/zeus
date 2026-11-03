import { useCallback, useMemo, useSyncExternalStore } from 'react';

/** 变更列表按项目保存，文件身份包含实际工作目录，避免不同 worktree 串组。 */
type ChangelistAssignments = Record<string, string>;
/** 同窗口组件与其他窗口的 storage 通知共用刷新入口。 */
const changedEvent = 'zeus:delivery-changelists-changed';

/** 空白和损坏的本机偏好不影响 Git 文件读取。 */
function parseAssignments(value: string | null): ChangelistAssignments {
  try {
    const parsed: unknown = JSON.parse(value ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, name]) => typeof name === 'string' && name.trim()));
  } catch {
    return {};
  }
}

/** 文件分组只改变展示，不改变提交勾选或暂存状态。 */
export function useDeliveryChangelists(projectId: string) {
  /** 与项目交付偏好使用相同的本机存储范围。 */
  const key = `zeus.git-delivery.changelists:${projectId}`;
  /** 订阅仅通知重新读取，写入时始终合并最新存储值。 */
  const store = useMemo(
    () => ({
      subscribe(listener: () => void) {
        window.addEventListener('storage', listener);
        window.addEventListener(changedEvent, listener);
        return () => {
          window.removeEventListener('storage', listener);
          window.removeEventListener(changedEvent, listener);
        };
      },
      read() {
        try {
          return localStorage.getItem(key);
        } catch {
          return null;
        }
      },
    }),
    [key],
  );
  const raw = useSyncExternalStore(store.subscribe, store.read, () => null);
  const assignments = useMemo(() => parseAssignments(raw), [raw]);
  /** 完整 Git 快照移除已处理文件的归属，文件再次修改时回到默认列表。 */
  const prune = useCallback(
    (repositories: Array<{ root: string; paths: string[] }>) => {
      const next = parseAssignments(localStorage.getItem(key));
      const active = new Map(repositories.map((repository) => [repository.root, new Set(repository.paths)]));
      let changed = false;
      for (const identity of Object.keys(next)) {
        try {
          const [root, path] = JSON.parse(identity) as [string, string];
          if (active.has(root) && !active.get(root)!.has(path)) {
            delete next[identity];
            changed = true;
          }
        } catch {
          /* 不解析其他格式的本机记录。 */
        }
      }
      if (changed) {
        localStorage.setItem(key, JSON.stringify(next));
        window.dispatchEvent(new Event(changedEvent));
      }
    },
    [key],
  );
  return {
    prune,
    /** 名称跨本项目仓库复用，空名称代表默认列表。 */
    names: [...new Set(Object.values(assignments))].sort((a, b) => a.localeCompare(b)),
    name(root: string, path: string) {
      return assignments[JSON.stringify([root, path])] ?? '';
    },
    move(root: string, paths: string[], name: string) {
      const next = parseAssignments(localStorage.getItem(key));
      for (const path of paths) {
        const identity = JSON.stringify([root, path]);
        if (name.trim()) next[identity] = name.trim();
        else delete next[identity];
      }
      localStorage.setItem(key, JSON.stringify(next));
      window.dispatchEvent(new Event(changedEvent));
    },
  };
}
