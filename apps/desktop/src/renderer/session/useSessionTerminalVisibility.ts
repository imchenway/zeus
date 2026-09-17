import { useCallback, useSyncExternalStore } from 'react';

// 面板可见性属于会话，生命周期跨越页面卸载；只有用户显式操作才改变它。
const openTerminals = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSessionTerminalVisibility(projectId: string | undefined, conversationId: string | undefined) {
  const key = projectId && conversationId ? JSON.stringify([projectId, conversationId]) : null;
  const getSnapshot = useCallback(() => key !== null && openTerminals.has(key), [key]);
  const open = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setOpen = useCallback(
    (visible: boolean): void => {
      if (key === null || openTerminals.has(key) === visible) return;
      if (visible) openTerminals.add(key);
      else openTerminals.delete(key);
      for (const listener of listeners) listener();
    },
    [key],
  );
  return [open, setOpen] as const;
}
