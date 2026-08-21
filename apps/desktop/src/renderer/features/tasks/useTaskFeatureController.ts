import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { TaskBoardViewSnapshot } from '@zeus/shared';
import type { TaskRecord } from '../../apiClient.js';
import type { TaskApiClient } from './taskApiClient.js';
import { TaskQueryStore } from './taskQueryStore.js';

export function useTaskFeatureController(input: { client: TaskApiClient | null; initialItems: readonly TaskRecord[] }) {
  const store = useMemo(() => new TaskQueryStore(input.client, input.initialItems), [input.client]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const replace = useCallback((items: readonly TaskRecord[]) => store.replace(items), [store]);
  const load = useCallback((query: Parameters<TaskApiClient['loadTasks']>[0]) => store.load(query), [store]);
  const loadOne = useCallback((taskId: string) => store.loadOne(taskId), [store]);
  const loadBoard = useCallback((projectId: string) => store.loadBoard(projectId), [store]);
  const setBoard = useCallback((projectId: string, board: TaskBoardViewSnapshot) => store.setBoard(projectId, board), [store]);
  const upsert = useCallback((task: TaskRecord) => store.upsert(task), [store]);
  const remove = useCallback((taskId: string) => store.remove(taskId), [store]);
  return { snapshot, replace, load, loadOne, loadBoard, setBoard, upsert, remove };
}
