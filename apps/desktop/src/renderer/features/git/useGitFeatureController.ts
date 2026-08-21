import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { GitDiffSummary, GitOperationConfirmation } from '../../apiClient.js';
import type { GitApiClient } from './gitApiClient.js';
import { GitQueryStore, type GitQueryFieldUpdater, type GitQuerySnapshot } from './gitQueryStore.js';

export function useGitFeatureController(input: { client: GitApiClient | null; initialDiff?: GitDiffSummary; initialConfirmation?: GitOperationConfirmation; patchNotExported: string; operationNotExecuted: string }) {
  const store = useMemo(
    () =>
      new GitQueryStore(input.client, {
        diff: input.initialDiff,
        confirmation: input.initialConfirmation,
        patchExportStatus: input.patchNotExported,
        operationStatus: input.operationNotExecuted,
      }),
    [input.client],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const set = useCallback(<Key extends keyof GitQuerySnapshot>(key: Key, updater: GitQueryFieldUpdater<Key>) => store.set(key, updater), [store]);
  const loadDiff = useCallback(() => store.loadDiff(), [store]);
  return { snapshot, set, loadDiff };
}
