import { useEffect, useRef } from 'react';
import type { FilePreviewRequest } from '@zeus/shared';

/** 各预览共用授权监听，连续写入合并为一次刷新，卸载后释放监听令牌。 */
export function useFilePreviewRefresh(request: FilePreviewRequest | null, onRefresh: () => void | Promise<void>, onError: (error: unknown) => void): void {
  /** 业务身份保持稳定时，正文和回调变化不重建磁盘监听。 */
  const identity = JSON.stringify(request);
  /** 监听回调读取当前标签的刷新动作，避免捕获旧的正文和状态。 */
  const callbacks = useRef({ onRefresh, onError });
  callbacks.current = { onRefresh, onError };
  useEffect(() => {
    const bridge = window.zeus;
    if (identity === 'null' || !bridge?.watchFilePreview || !bridge.onFilePreviewChanged) return;
    let active = true;
    let id: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = bridge.onFilePreviewChanged((changedId) => {
      if (changedId !== id) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void Promise.resolve(callbacks.current.onRefresh()).catch((error: unknown) => {
          if (active) callbacks.current.onError(error);
        });
      }, 200);
    });
    void bridge.watchFilePreview(JSON.parse(identity) as FilePreviewRequest).then(
      (value) => {
        if (!value) return;
        if (!active) {
          void bridge.releaseFilePreview([value]).catch(() => undefined);
          return;
        }
        id = value;
        // 建立监听后重读一次，补齐打开快照到监听生效之间的修改。
        void Promise.resolve(callbacks.current.onRefresh()).catch((error: unknown) => {
          if (active) callbacks.current.onError(error);
        });
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
  }, [identity]);
}
