import { useCallback, useEffect, useState } from 'react';
import type { GitFileBlame } from '../features/git/gitContracts.js';
import { invalidateGitBlame, readCachedGitBlame } from './gitBlameCache.js';

export interface UseGitBlameOptions {
  projectId?: string;
  filePath?: string;
  ref?: string;
  /** 未保存编辑期间暂停磁盘归属，避免显示旧行号。 */
  suspended?: boolean;
  /** 磁盘内容变更后使用新缓存，避免保存后复用旧行号。 */
  revision?: string;
  /** 会话源码只能用资源身份解析，不回退项目主目录。 */
  conversationId?: string;
  resourceId?: string;
  content?: string;
}

export interface UseGitBlameResult {
  blame: GitFileBlame | null;
  loading: boolean;
  available: boolean;
  error: Error | null;
  reload: () => void;
}

/** 默认读取归属，按项目、文件和版本合并请求，避免滚动或重新渲染重复启动 Git。 */
export function useGitBlame(options: UseGitBlameOptions): UseGitBlameResult {
  const projectId = options.projectId?.trim() ?? '';
  // 文件名两端的空格是合法路径内容，校验时只用 trim，不改变实际 IPC 参数。
  const filePath = options.filePath ?? '';
  const ref = options.ref?.trim() || undefined;
  const { conversationId, resourceId, content, revision, suspended = false } = options;
  const resource = Boolean(conversationId || resourceId);
  const cacheKey = projectId ? JSON.stringify(resource ? ['resource', projectId, conversationId, resourceId] : ['project', projectId, filePath, ref]) : '';
  const available = Boolean(
    projectId && typeof window !== 'undefined' && (resource ? conversationId && resourceId && content !== undefined && window.zeus?.loadConversationSourceBlame : filePath.trim() && window.zeus?.loadProjectSourceBlame),
  );
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [blame, setBlame] = useState<{ key: string; revision?: string; content?: string; value: GitFileBlame } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    if (!available || !cacheKey || suspended) {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setBlame(null);
    setError(null);
    setLoading(true);
    const load = async () => {
      const expectedSha256 =
        !resource && ref ? undefined : content === undefined ? revision : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))), (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (!active) return null;
      return readCachedGitBlame(
        cacheKey,
        expectedSha256 ?? '',
        () =>
          resource
            ? window.zeus!.loadConversationSourceBlame({ projectId, conversationId: conversationId!, resourceId: resourceId!, expectedSha256: expectedSha256! })
            : window.zeus!.loadProjectSourceBlame({ projectId, relativePath: filePath, ...(ref ? { ref } : {}), ...(expectedSha256 ? { expectedSha256 } : {}) }),
        // 保存内容相同不代表 HEAD 没变；重新激活文件时刷新归属，同时合并并发请求。
        true,
      );
    };
    void load()
      .then((value) => {
        if (active && value) setBlame({ key: cacheKey, revision, content, value });
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
  }, [available, cacheKey, filePath, projectId, ref, refreshVersion, resource, conversationId, resourceId, content, revision, suspended]);

  const reload = useCallback(() => {
    if (cacheKey) invalidateGitBlame(cacheKey);
    setRefreshVersion((value) => value + 1);
  }, [cacheKey]);

  useEffect(() => {
    if (!available || suspended) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(reload, 150);
    };
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const unsubscribe = window.zeus?.onProjectSourceEvent((event) => {
      if (event.projectId === projectId && (!event.relativePath || event.relativePath === filePath || event.kind === 'unknown')) refresh();
    });
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearTimeout(timer);
      unsubscribe?.();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [available, suspended, projectId, filePath, reload]);

  return { blame: blame?.key === cacheKey && blame.revision === revision && blame.content === content ? blame.value : null, loading, available, error, reload };
}
