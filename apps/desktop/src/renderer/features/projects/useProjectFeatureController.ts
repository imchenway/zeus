import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ProjectRecord } from '../../apiClient.js';
import type { ProjectApiClient } from './projectApiClient.js';
import { ProjectQueryStore } from './projectQueryStore.js';
import { projectActivityOrderStorageKey } from './projectActivityOrder.js';

/** 项目查询、小时刷新与本机跨窗口顺序同步的统一入口。 */
export function useProjectFeatureController(input: { client: ProjectApiClient | null; initialItems: readonly ProjectRecord[] }) {
  const store = useMemo(() => new ProjectQueryStore(input.client, input.initialItems), [input.client]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  /** 只有完整查询结果可以触发排序，局部命令回执只合并内容。 */
  const replace = useCallback((items: readonly ProjectRecord[], complete = true) => store.replace(items, complete), [store]);
  const select = useCallback((projectId: string | null) => store.select(projectId), [store]);
  const load = useCallback((query?: string) => store.load(query), [store]);
  const loadOne = useCallback((projectId: string) => store.loadOne(projectId), [store]);
  const upsert = useCallback((project: ProjectRecord) => store.upsert(project), [store]);
  const remove = useCallback((projectId: string) => store.remove(projectId), [store]);
  useEffect(() => {
    /** 一小时的毫秒数，与后端 UTC 小时统计保持一致。 */
    const hourMilliseconds = 60 * 60 * 1000;
    /** 按整点重新预约，休眠后只刷新当前小时。 */
    let timer: ReturnType<typeof setTimeout>;
    /** 本轮最多发起一次刷新，失败保留原顺序与查询错误，不循环重试。 */
    let attemptedHour = -1;
    /** 卸载后不再预约下一次刷新。 */
    let disposed = false;
    /** 只有完整列表过期时才加载，项目关闭或收起不影响统计范围。 */
    function refreshActivity(): void {
      if (!input.client || document.visibilityState === 'hidden') return;
      /** 当前真实时间决定刷新窗口，不补放休眠期间错过的小时。 */
      const hour = Math.floor(Date.now() / hourMilliseconds);
      if (attemptedHour === hour || store.getSnapshot().loading || store.getActivityHour() >= hour) return;
      attemptedHour = hour;
      void store.load().catch(() => {
        // 查询层已保存真实错误，保留现有顺序；下一小时或既有显式刷新入口再读取。
      });
    }
    /** 每次按绝对整点计算延迟，避免固定间隔累计漂移。 */
    function scheduleActivityRefresh(): void {
      if (disposed) return;
      timer = setTimeout(
        () => {
          refreshActivity();
          scheduleActivityRefresh();
        },
        hourMilliseconds - (Date.now() % hourMilliseconds) + 50,
      );
    }
    /** 另一个窗口已冻结顺序时采用同一份偏好，不重新统计。 */
    function synchronizeOrder(event: StorageEvent): void {
      if (event.key === projectActivityOrderStorageKey) store.replace(store.getSnapshot().items, false);
    }
    store.replace(store.getSnapshot().items);
    refreshActivity();
    scheduleActivityRefresh();
    /** 若整点恰逢其他查询进行中，在其结束后补齐当前小时。 */
    const unsubscribe = store.subscribe(refreshActivity);
    window.addEventListener('focus', refreshActivity);
    document.addEventListener('visibilitychange', refreshActivity);
    window.addEventListener('storage', synchronizeOrder);
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('focus', refreshActivity);
      document.removeEventListener('visibilitychange', refreshActivity);
      window.removeEventListener('storage', synchronizeOrder);
    };
  }, [store, input.client]);
  return { snapshot, replace, select, load, loadOne, upsert, remove };
}
