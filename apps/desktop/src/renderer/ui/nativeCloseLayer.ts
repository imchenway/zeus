import { useEffect, useRef } from 'react';
import { useWindowDocument } from './windowDocument.js';

interface NativeCloseLayerEntry {
  id: symbol;
  close: () => void;
  /** 系统窗口各自维护最上层，不关闭其他窗口里的表单。 */
  document: Document;
}

const closeLayers: NativeCloseLayerEntry[] = [];
let removeNativeCloseListener: (() => void) | undefined;

/** 原生 Cmd+W 只关闭当前最上层注册对象，不穿透到下面的模态层、内容标签或窗口。 */
export function initializeNativeCloseLayerRouting(): void {
  if (removeNativeCloseListener) return;
  removeNativeCloseListener = window.zeus?.onNativeCloseFrontmostLayer?.(() => {
    closeDocumentLayer(document);
  });
  syncNativeCloseLayerActivity();
}

/** 组件卸载或关闭时同步移除注册，避免 Main 进程保留过期的前台层状态。 */
export function useNativeCloseLayer(active: boolean, close: () => void): void {
  /** 当前组件所属的实际窗口。 */
  const ownerDocument = useWindowDocument();
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!active) return;
    const entry: NativeCloseLayerEntry = {
      id: Symbol('zeus-native-close-layer'),
      close: () => closeRef.current(),
      document: ownerDocument,
    };
    closeLayers.push(entry);
    syncNativeCloseLayerActivity();
    return () => {
      const index = closeLayers.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) closeLayers.splice(index, 1);
      syncNativeCloseLayerActivity();
    };
  }, [active, ownerDocument]);
}

/** 系统关闭和应用快捷键共用每个文档的顶层关闭规则。 */
export function closeDocumentLayer(ownerDocument: Document): void {
  closeLayers.findLast((entry) => entry.document === ownerDocument)?.close();
}

function syncNativeCloseLayerActivity(): void {
  window.zeus?.notifyAppCloseLayerActivity?.(closeLayers.some((entry) => entry.document === document));
}
