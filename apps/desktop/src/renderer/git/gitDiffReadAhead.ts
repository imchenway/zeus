import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { FilePreviewRequest } from '@zeus/shared';
import type { GitDiffSummary } from '../apiClient.js';
import { prepareFilePreview, type PreparedFilePreview } from '../code/preparedFilePreview.js';

/** 同一快照下的单文件结果和唯一在途读取。 */
export interface GitDiffRead {
  read: Promise<GitDiffSummary>;
  result?: GitDiffSummary;
  /** 补丁和可编辑正文同时准备，切换时不再替换编辑器类型。 */
  preview?: PreparedFilePreview;
}

/** 预读只携带现有业务接口，不接收或扩展磁盘路径权限。 */
export interface GitDiffReadTarget {
  key: string;
  load: () => Promise<GitDiffSummary>;
  /** 沿用当前文件预览的业务身份和比较范围。 */
  previewRequest?: FilePreviewRequest;
}

/** 正文缓存最多占三十二 MiB；可见预览的引用不受后台淘汰影响。 */
function prepareCachedPreview(cache: Map<string, GitDiffRead>, entry: GitDiffRead, request: FilePreviewRequest): void {
  if (entry.preview) return;
  const preview = (entry.preview = prepareFilePreview(request));
  void preview.read.then(
    () => {
      if (entry.preview !== preview) return;
      let bytes = [...cache.values()].reduce((total, item) => total + (item.preview?.byteLength ?? 0), 0);
      for (const item of cache.values()) {
        if (bytes <= 32 * 1024 * 1024) break;
        if (!item.preview) continue;
        bytes -= item.preview.byteLength;
        item.preview.dispose();
        item.preview = undefined;
      }
    },
    () => {
      if (entry.preview === preview) entry.preview = undefined;
      preview.dispose();
    },
  );
}

/** 三十二项预读之外保留十六项回看空间；失败结果允许点击重试。 */
export function readCachedGitDiff(cache: Map<string, GitDiffRead>, target: GitDiffReadTarget): GitDiffRead {
  const cached = cache.get(target.key);
  if (cached) {
    cache.delete(target.key);
    cache.set(target.key, cached);
    if (target.previewRequest) prepareCachedPreview(cache, cached, target.previewRequest);
    return cached;
  }
  const entry: GitDiffRead = {
    read: Promise.resolve()
      .then(target.load)
      .then((diff) => {
        entry.result = diff;
        return diff;
      })
      .catch((error: unknown) => {
        if (cache.get(target.key) === entry) cache.delete(target.key);
        entry.preview?.dispose();
        throw error;
      }),
  };
  cache.set(target.key, entry);
  if (target.previewRequest) prepareCachedPreview(cache, entry, target.previewRequest);
  if (cache.size > 48) {
    const oldest = cache.keys().next().value!;
    cache.get(oldest)?.preview?.dispose();
    cache.delete(oldest);
  }
  return entry;
}

/** 空闲时逐个准备当前仓库附近三十二项；切范围后停止后续读取。 */
export function useGitDiffReadAhead(cache: Map<string, GitDiffRead>, targets: GitDiffReadTarget[], enabled: boolean): void {
  useEffect(
    () => () => {
      for (const entry of cache.values()) entry.preview?.dispose();
      cache.clear();
    },
    [cache],
  );
  useEffect(() => {
    if (!enabled || !targets.length) return;
    let cancelled = false;
    const idle = window.requestIdleCallback(
      () => {
        void (async () => {
          for (const target of targets.slice(0, 32)) {
            if (cancelled) return;
            const entry = readCachedGitDiff(cache, target);
            await Promise.allSettled([entry.read, entry.preview?.read]);
          }
        })();
      },
      { timeout: 500 },
    );
    return () => {
      cancelled = true;
      window.cancelIdleCallback(idle);
    };
  }, [cache, targets, enabled]);
}

/** 旧文件保持可读，最新一次选择的补丁和全文就绪后一起切换。 */
export function usePreparedGitDiffSelection(
  cache: Map<string, GitDiffRead>,
  targetFor: (id: string, path: string) => GitDiffReadTarget | null,
  select: (id: string, path: string) => void,
  onError: (error: unknown) => void,
  enabled: boolean,
) {
  /** 快速点击、换范围和卸载后，旧结果不能改变当前选择。 */
  const sequence = useRef(0);
  useLayoutEffect(
    () => () => {
      sequence.current += 1;
    },
    [cache, targetFor, enabled],
  );
  return useCallback(
    async (id: string, path: string) => {
      if (!enabled) return;
      const request = ++sequence.current;
      const target = targetFor(id, path);
      if (!target) return;
      const entry = readCachedGitDiff(cache, target);
      try {
        await Promise.all([entry.read, entry.preview?.read]);
        if (request === sequence.current) select(id, path);
      } catch (error: unknown) {
        if (request === sequence.current) onError(error);
      }
    },
    [cache, targetFor, select, onError, enabled],
  );
}
