import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * 只标记当前列表真实新增的对象；首批历史数据不播放逐项入场，避免打开页面时整列内容排队闪动。
 */
export function useNewItemMotionIds(ids: readonly string[], durationMs = 220, baselineReady = true, eligibleIds?: readonly string[]): ReadonlySet<string> {
  /** 调用方保持键数组时无需再次序列化整段历史。 */
  const previousIds = useRef<readonly string[]>([]);
  if (ids.length !== previousIds.current.length || ids.some((id, index) => id !== previousIds.current[index])) previousIds.current = ids;
  const stableIds = previousIds.current;
  const eligibleRef = useRef(eligibleIds);
  eligibleRef.current = eligibleIds;
  const initializedRef = useRef(false);
  const knownIdsRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, number>>(new Map());
  const [enteringIds, setEnteringIds] = useState<ReadonlySet<string>>(() => new Set());

  useLayoutEffect(() => {
    const currentIds = new Set(stableIds);
    if (!baselineReady) {
      // 首次权威数据尚未到达时只跟踪当前壳层，不能把后续整批历史误判为实时新增消息。
      knownIdsRef.current = currentIds;
      return;
    }
    if (!initializedRef.current) {
      initializedRef.current = true;
      knownIdsRef.current = currentIds;
      return;
    }

    const eligible = eligibleRef.current ? new Set(eligibleRef.current) : null;
    const addedIds = stableIds.filter((id) => !knownIdsRef.current.has(id) && (!eligible || eligible.has(id)));
    knownIdsRef.current = currentIds;
    if (addedIds.length === 0) return;

    setEnteringIds((current) => new Set([...current, ...addedIds]));
    for (const id of addedIds) {
      const activeTimer = timersRef.current.get(id);
      if (activeTimer !== undefined) window.clearTimeout(activeTimer);
      const timer = window.setTimeout(() => {
        timersRef.current.delete(id);
        setEnteringIds((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }, durationMs);
      timersRef.current.set(id, timer);
    }
  }, [baselineReady, durationMs, stableIds]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) window.clearTimeout(timer);
      timersRef.current.clear();
    },
    [],
  );

  return enteringIds;
}
