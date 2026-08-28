import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { RemoteControlApiClient } from './remoteControlApiClient.js';
import { RemoteControlQueryStore } from './remoteControlQueryStore.js';

export function useRemoteControlFeatureController(client: RemoteControlApiClient | null) {
  const store = useMemo(() => (client ? new RemoteControlQueryStore(client) : null), [client]);
  const emptyStore = useMemo(() => new RemoteControlQueryStore(unavailableClient), []);
  const activeStore = store ?? emptyStore;
  const snapshot = useSyncExternalStore(activeStore.subscribe, activeStore.getSnapshot, activeStore.getSnapshot);

  useEffect(() => {
    if (store) void store.load();
  }, [store]);

  const reload = useCallback(() => activeStore.load(), [activeStore]);
  const enable = useCallback(() => activeStore.enable(), [activeStore]);
  const disable = useCallback(() => activeStore.disable(), [activeStore]);
  const startPairing = useCallback(() => activeStore.startPairing(), [activeStore]);
  const refreshPairing = useCallback((claimedMessage: string) => activeStore.refreshPairing(claimedMessage), [activeStore]);
  const revoke = useCallback((environmentId: string, clientId: string) => activeStore.revoke(environmentId, clientId), [activeStore]);
  const setMessage = useCallback((message: string | null) => activeStore.setMessage(message), [activeStore]);

  return {
    snapshot,
    reload,
    enable,
    disable,
    startPairing,
    refreshPairing,
    revoke,
    setMessage,
  };
}

const unavailableClient: RemoteControlApiClient = {
  loadCodexRemoteControl: () => Promise.reject(new Error('Remote Control client is unavailable.')),
  enableCodexRemoteControl: () => Promise.reject(new Error('Remote Control client is unavailable.')),
  disableCodexRemoteControl: () => Promise.reject(new Error('Remote Control client is unavailable.')),
  startCodexRemoteControlPairing: () => Promise.reject(new Error('Remote Control client is unavailable.')),
  loadCodexRemoteControlPairingStatus: () => Promise.reject(new Error('Remote Control client is unavailable.')),
  revokeCodexRemoteControlClient: () => Promise.reject(new Error('Remote Control client is unavailable.')),
};
