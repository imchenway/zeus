import { useCallback, useEffect, useState } from 'react';
import type { GitFileBlame } from '../features/git/gitContracts.js';

export interface UseGitBlameOptions {
  projectId?: string;
  filePath?: string;
  ref?: string;
  initiallyVisible?: boolean;
}

export interface UseGitBlameResult {
  blame: GitFileBlame | null;
  enabled: boolean;
  loading: boolean;
  available: boolean;
  error: Error | null;
  toggle: () => void;
  reload: () => void;
}

interface BlameCacheEntry {
  value?: GitFileBlame;
  promise?: Promise<GitFileBlame>;
  updatedAt: number;
}

const blameCache = new Map<string, BlameCacheEntry>();
const blameCacheTtlMs = 30_000;

/** 按项目、文件和版本共享短期读取结果，避免滚动或重新渲染重复启动 Git。 */
export function useGitBlame(options: UseGitBlameOptions): UseGitBlameResult {
  const projectId = options.projectId?.trim() ?? '';
  // 文件名两端的空格是合法路径内容，校验时只用 trim，不改变实际 IPC 参数。
  const filePath = options.filePath ?? '';
  const ref = options.ref?.trim() || undefined;
  const cacheKey = projectId && filePath.trim() ? `${projectId}\0${filePath}\0${ref ?? ''}` : '';
  const available = Boolean(projectId && filePath.trim() && typeof window !== 'undefined' && window.zeus?.loadProjectSourceBlame);
  const [enabled, setEnabled] = useState(options.initiallyVisible ?? true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [blame, setBlame] = useState<GitFileBlame | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    if (!enabled || !available || !cacheKey) {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setBlame(null);
    setError(null);
    setLoading(true);
    const loader = window.zeus?.loadProjectSourceBlame;
    if (!loader) return undefined;
    void readCachedBlame(cacheKey, () => loader({ projectId, relativePath: filePath, ...(ref ? { ref } : {}) }))
      .then((value) => {
        if (active) setBlame(value);
      })
      .catch((cause: unknown) => {
        if (active) {
          setBlame(null);
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [available, cacheKey, enabled, filePath, projectId, ref, refreshVersion]);

  const toggle = useCallback(() => setEnabled((value) => !value), []);
  const reload = useCallback(() => {
    if (cacheKey) blameCache.delete(cacheKey);
    setRefreshVersion((value) => value + 1);
  }, [cacheKey]);

  return { blame, enabled, loading, available, error, toggle, reload };
}

async function readCachedBlame(key: string, load: () => Promise<GitFileBlame>): Promise<GitFileBlame> {
  const now = Date.now();
  const cached = blameCache.get(key);
  if (cached?.value && now - cached.updatedAt < blameCacheTtlMs) return cached.value;
  if (cached?.promise) return cached.promise;

  const promise = load()
    .then((value) => {
      blameCache.set(key, { value, updatedAt: Date.now() });
      return value;
    })
    .catch((error: unknown) => {
      blameCache.delete(key);
      throw error;
    });
  blameCache.set(key, { promise, updatedAt: now });
  return promise;
}
