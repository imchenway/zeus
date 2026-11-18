import { useDeferredValue, useEffect, useState } from 'react';
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

/** 预读只缓存补丁；当前文件额外准备授权全文，失败结果允许重试。 */
export function readCachedGitDiff(cache: Map<string, GitDiffRead>, target: GitDiffReadTarget, selected = false): GitDiffRead {
  const cached = cache.get(target.key);
  if (cached) {
    cache.delete(target.key);
    cache.set(target.key, cached);
    if (selected && target.previewRequest) prepareCachedPreview(cache, cached, target.previewRequest);
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
  if (selected && target.previewRequest) prepareCachedPreview(cache, entry, target.previewRequest);
  if (cache.size > 48) {
    const oldest = cache.keys().next().value!;
    cache.get(oldest)?.preview?.dispose();
    cache.delete(oldest);
  }
  return entry;
}

/** 空闲时预读附近文件的补丁；全文授权只在实际选中文件时发起。 */
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
            await entry.read.catch(() => undefined);
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

/** 选中状态由文件树立即提交，补丁结果只更新与其对应的审阅文件。 */
export function useGitDeliveryFileDiff(cache: Map<string, GitDiffRead>, target: GitDiffReadTarget | null, identity: string) {
  /** 命中补丁缓存时也先提交文件选中态，再构建差异正文。 */
  const displaying = useDeferredValue(identity) === identity;
  /** 刷新时保留同一个文件的补丁，失败则允许重读该文件。 */
  const [settled, setSettled] = useState<{ target: GitDiffReadTarget; identity: string; diff: GitDiffSummary | null; error?: unknown }>();
  /** 失败已移出缓存，重试只触发当前文件。 */
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!target) return;
    /** 切换文件、范围或关闭后忽略迟到结果。 */
    let active = true;
    void readCachedGitDiff(cache, target, true).read.then(
      (diff) => {
        if (active) setSettled({ target, identity, diff });
      },
      (error: unknown) => {
        if (active) setSettled((current) => ({ target, identity, diff: current?.identity === identity ? current.diff : null, error }));
      },
    );
    return () => {
      active = false;
    };
  }, [cache, target, identity, attempt]);
  /** 已预读的补丁可直接显示，仍在读取的全文交给共享预览处理。 */
  const entry = target ? cache.get(target.key) : undefined;
  /** 当前工作区及比较范围相同才允许保留上一次差异。 */
  const diff = displaying ? (entry?.result ?? (settled?.identity === identity ? settled.diff : null)) : null;
  return {
    diff,
    diffLoading: Boolean(target && (!displaying || (!diff && settled?.target !== target))),
    diffError: settled?.target === target ? settled?.error : undefined,
    preparedPreview: entry?.preview,
    /** 重新请求失败的补丁，审阅焦点和其他仓库状态不动。 */
    onRetryDiff: () => {
      setSettled(undefined);
      setAttempt((current) => current + 1);
    },
  };
}
