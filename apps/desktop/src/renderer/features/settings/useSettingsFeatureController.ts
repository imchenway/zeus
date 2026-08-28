import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { AppShellSettings } from '../../apiClient.js';
import type { SettingsApiClient } from './settingsApiClient.js';
import { SettingsQueryStore, type SettingsUpdater } from './settingsQueryStore.js';

export function useSettingsFeatureController(input: { client: SettingsApiClient | null; initialValue: AppShellSettings }) {
  const store = useMemo(() => new SettingsQueryStore(input.client, input.initialValue), [input.client]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const update = useCallback((updater: SettingsUpdater) => store.update(updater), [store]);
  const load = useCallback(() => store.load(), [store]);
  const save = useCallback((request: Parameters<SettingsApiClient['saveAppShellSettings']>[0]) => store.save(request), [store]);
  return { snapshot, update, load, save };
}
