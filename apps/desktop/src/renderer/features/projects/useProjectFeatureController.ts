import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { ProjectRecord } from '../../apiClient.js';
import type { ProjectApiClient } from './projectApiClient.js';
import { ProjectQueryStore } from './projectQueryStore.js';

export function useProjectFeatureController(input: { client: ProjectApiClient | null; initialItems: readonly ProjectRecord[] }) {
  const store = useMemo(() => new ProjectQueryStore(input.client, input.initialItems), [input.client]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const replace = useCallback((items: readonly ProjectRecord[]) => store.replace(items), [store]);
  const select = useCallback((projectId: string | null) => store.select(projectId), [store]);
  const load = useCallback((query?: string) => store.load(query), [store]);
  const loadOne = useCallback((projectId: string) => store.loadOne(projectId), [store]);
  const upsert = useCallback((project: ProjectRecord) => store.upsert(project), [store]);
  const remove = useCallback((projectId: string) => store.remove(projectId), [store]);
  return { snapshot, replace, select, load, loadOne, upsert, remove };
}
