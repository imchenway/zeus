import { useEffect, useRef } from 'react';

interface NativeCloseLayerEntry {
  id: symbol;
  close: () => void;
}

const closeLayers: NativeCloseLayerEntry[] = [];
let removeNativeCloseListener: (() => void) | undefined;

/** 原生 Cmd+W 只关闭当前最上层注册对象，不穿透到下面的模态层、内容标签或窗口。 */
export function initializeNativeCloseLayerRouting(): void {
  if (removeNativeCloseListener) return;
  removeNativeCloseListener = window.zeus?.onNativeCloseFrontmostLayer?.(() => {
    closeLayers.at(-1)?.close();
  });
  syncNativeCloseLayerActivity();
}

/** 组件卸载或关闭时同步移除注册，避免 Main 进程保留过期的前台层状态。 */
export function useNativeCloseLayer(active: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!active) return;
    const entry: NativeCloseLayerEntry = {
      id: Symbol('zeus-native-close-layer'),
      close: () => closeRef.current(),
    };
    closeLayers.push(entry);
    syncNativeCloseLayerActivity();
    return () => {
      const index = closeLayers.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) closeLayers.splice(index, 1);
      syncNativeCloseLayerActivity();
    };
  }, [active]);
}

function syncNativeCloseLayerActivity(): void {
  window.zeus?.notifyAppCloseLayerActivity?.(closeLayers.length > 0);
}
