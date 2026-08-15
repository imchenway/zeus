import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * 只标记当前列表真实新增的对象；首批历史数据不播放逐项入场，避免打开页面时整列内容排队闪动。
 */
export function useNewItemMotionIds(ids: readonly string[], durationMs = 220, baselineReady = true): ReadonlySet<string> {
  const identity = JSON.stringify(ids);
  const stableIds = useMemo(() => JSON.parse(identity) as string[], [identity]);
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

    const addedIds = stableIds.filter((id) => !knownIdsRef.current.has(id));
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
