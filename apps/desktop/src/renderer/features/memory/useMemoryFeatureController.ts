import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { MemoryApiClient } from './memoryApiClient.js';
import type { MemoryScope } from './memoryContracts.js';
import { MemoryQueryStore } from './memoryQueryStore.js';

export function useMemoryFeatureController(input: { client: MemoryApiClient; scope: MemoryScope; refreshRevision?: number }) {
  const store = useMemo(() => new MemoryQueryStore(input.client), [input.client]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    void store.setQuery({ scope: input.scope, includeTombstones: true, limit: 50 });
  }, [input.scope.id, input.scope.kind, store]);

  /** 外部接纳经验后只重读列表，不清空正在编辑的表单。 */
  useEffect(() => {
    if (input.refreshRevision !== undefined) void store.reload();
  }, [input.refreshRevision, store]);

  return {
    snapshot,
    reload: () => store.reload(),
    loadMore: () => store.loadMore(),
    create: store.create.bind(store),
    supersede: store.supersede.bind(store),
    tombstone: store.tombstone.bind(store),
  };
}
