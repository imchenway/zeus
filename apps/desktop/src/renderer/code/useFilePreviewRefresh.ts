import { useEffect, useRef } from 'react';
import type { FilePreviewItem, FilePreviewRequest } from '@zeus/shared';

/** 各预览共用授权监听，连续写入合并为一次刷新，卸载后释放监听令牌。 */
export function useFilePreviewRefresh(request: FilePreviewRequest | null, onRefresh: () => void | Promise<void>, onError: (error: unknown) => void, { items, revision }: { items?: FilePreviewItem[] | null; revision?: string } = {}): void {
  /** 一次监听对应稳定的业务身份和已显示的版本。 */
  const identity = JSON.stringify(request);
  /** 监听回调读取当前标签的刷新动作，避免捕获旧的正文和状态。 */
  const callbacks = useRef({ onRefresh, onError });
  callbacks.current = { onRefresh, onError };
  useEffect(() => {
    const bridge = window.zeus;
    if (identity === 'null' || items === null || !bridge?.watchFilePreview || !bridge.onFilePreviewChanged) return;
    let active = true;
    let id: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 监听注册完成之前到达的事件在收到令牌后核对。 */
    const pendingChanges = new Set<string>();
    /** 同一轮磁盘变化只启动一次读取。 */
    function scheduleRefresh() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void Promise.resolve(callbacks.current.onRefresh()).catch((error: unknown) => {
          if (active) callbacks.current.onError(error);
        });
      }, 200);
    }
    const unsubscribe = bridge.onFilePreviewChanged((changedId) => {
      if (id === null) pendingChanges.add(changedId);
      else if (changedId === id) scheduleRefresh();
    });
    void bridge.watchFilePreview(JSON.parse(identity) as FilePreviewRequest, items?.map((item) => item.id).filter(Boolean), revision).then(
      (value) => {
        if (!value) return;
        if (!active) {
          void bridge.releaseFilePreview([value.id]).catch(() => undefined);
          return;
        }
        id = value.id;
        if (value.changed || pendingChanges.has(id)) scheduleRefresh();
        pendingChanges.clear();
      },
      (error: unknown) => {
        if (active) callbacks.current.onError(error);
      },
    );
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
      if (id) void bridge.releaseFilePreview([id]).catch(() => undefined);
    };
  }, [identity, items, revision]);
}
