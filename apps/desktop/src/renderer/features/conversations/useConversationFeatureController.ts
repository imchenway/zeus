import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { NativeConversationChoice, NativeConversationChoicesSnapshot, NativeProjectConversationChoicesSnapshot } from '../../session/sessionTypes.js';
import type { ConversationApiClient } from './conversationApiClient.js';
import { ConversationQueryStore, type ConversationQuerySnapshot } from './conversationQueryStore.js';

export function useConversationFeatureController(input: {
  client: ConversationApiClient | null;
  initialTaskChoices?: readonly NativeConversationChoicesSnapshot[];
  initialProjectChoices?: readonly NativeProjectConversationChoicesSnapshot[];
}) {
  const store = useMemo(() => new ConversationQueryStore(input.client, { taskChoices: input.initialTaskChoices, projectChoices: input.initialProjectChoices }), [input.client]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const updateTaskChoices = useCallback(
    (updater: Readonly<Record<string, NativeConversationChoicesSnapshot>> | ((current: Readonly<Record<string, NativeConversationChoicesSnapshot>>) => Readonly<Record<string, NativeConversationChoicesSnapshot>>)) =>
      store.updateTaskChoices(updater),
    [store],
  );
  const updateProjectChoices = useCallback(
    (updater: Readonly<Record<string, NativeProjectConversationChoicesSnapshot>> | ((current: Readonly<Record<string, NativeProjectConversationChoicesSnapshot>>) => Readonly<Record<string, NativeProjectConversationChoicesSnapshot>>)) =>
      store.updateProjectChoices(updater),
    [store],
  );
  const setArchived = useCallback((items: readonly NativeConversationChoice[]) => store.setArchived(items), [store]);
  const setArchivedLoadState = useCallback((state: ConversationQuerySnapshot['archivedLoadState']) => store.setArchivedLoadState(state), [store]);
  const setRestoringConversationId = useCallback((conversationId: string | null) => store.setRestoringConversationId(conversationId), [store]);
  const loadArchived = useCallback(() => store.loadArchived(), [store]);
  return { snapshot, updateTaskChoices, updateProjectChoices, setArchived, setArchivedLoadState, setRestoringConversationId, loadArchived };
}
