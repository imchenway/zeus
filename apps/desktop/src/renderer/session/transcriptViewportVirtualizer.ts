import { type RefCallback, type RefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

export const transcriptViewportEstimatedRowHeightPx = 132;
export const transcriptViewportRowGapPx = 14;
export const transcriptViewportOverscanPx = 900;
export const transcriptViewportMaximumWindowRows = 48;
export const transcriptViewportMeasurementCacheLimit = 384;

export type TranscriptViewportSlot = { kind: 'row'; key: string; rowKey: string; index: number } | { kind: 'spacer'; key: string; height: number; startIndex: number; endIndex: number };

export interface TranscriptViewportProjection {
  slots: TranscriptViewportSlot[];
  renderedRowCount: number;
  pinnedRowCount: number;
  windowStartIndex: number;
  windowEndIndex: number;
  estimatedTotalHeight: number;
}

/** 只保存最近测量值；淘汰后按稳定行身份和保守估高恢复，不保留 DOM 或正文。 */
export class TranscriptRowMeasurementCache {
  private readonly entries = new Map<string, number>();

  constructor(readonly limit = transcriptViewportMeasurementCacheLimit) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Transcript measurement cache limit must be a positive integer.');
  }

  get size(): number {
    return this.entries.size;
  }

  peek(key: string): number | undefined {
    return this.entries.get(key);
  }

  remember(key: string, height: number): void {
    if (!key || !Number.isFinite(height) || height <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, height);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * 稳定身份的变高行布局。滚动时只做二分和窗口投影；行集合变化时才重建前缀树。
 * 基础 DOM 永远不超过 maximumWindowRows，活动、展开和焦点行作为显式保留项附加。
 */
export class TranscriptViewportLayout {
  private rowKeys: string[] = [];
  private readonly indexByKey = new Map<string, number>();
  private heights = new Float64Array(0);
  private heightTree = new Float64Array(1);

  constructor(
    private readonly estimatedRowHeight = transcriptViewportEstimatedRowHeightPx,
    private readonly rowGap = transcriptViewportRowGapPx,
  ) {
    if (!Number.isFinite(estimatedRowHeight) || estimatedRowHeight <= 0) throw new Error('Transcript estimated row height must be positive.');
    if (!Number.isFinite(rowGap) || rowGap < 0) throw new Error('Transcript row gap must be non-negative.');
  }

  syncKeys(rowKeys: readonly string[], measurements: TranscriptRowMeasurementCache): void {
    if (this.sameKeys(rowKeys)) return;
    this.rowKeys = [...rowKeys];
    this.indexByKey.clear();
    this.heights = new Float64Array(rowKeys.length);
    this.heightTree = new Float64Array(rowKeys.length + 1);
    rowKeys.forEach((key, index) => {
      if (this.indexByKey.has(key)) throw new Error(`Transcript row identity is not unique: ${key}`);
      this.indexByKey.set(key, index);
      const height = measurements.peek(key) ?? this.estimatedRowHeight;
      this.heights[index] = height;
      this.addHeight(index, height);
    });
  }

  updateMeasuredHeight(rowKey: string, height: number, measurements: TranscriptRowMeasurementCache): boolean {
    const index = this.indexByKey.get(rowKey);
    if (index === undefined || !Number.isFinite(height) || height <= 0) return false;
    measurements.remember(rowKey, height);
    const previous = this.heights[index] ?? this.estimatedRowHeight;
    if (Math.abs(previous - height) < 0.5) return false;
    this.heights[index] = height;
    this.addHeight(index, height - previous);
    return true;
  }

  project(input: { scrollTop: number | null; viewportHeight: number; pinnedRowKeys?: ReadonlySet<string>; overscanPx?: number; maximumWindowRows?: number }): TranscriptViewportProjection {
    const rowCount = this.rowKeys.length;
    const estimatedTotalHeight = this.totalHeight();
    if (rowCount === 0) {
      return { slots: [], renderedRowCount: 0, pinnedRowCount: 0, windowStartIndex: 0, windowEndIndex: -1, estimatedTotalHeight };
    }
    const viewportHeight = positiveMetric(input.viewportHeight, 720);
    const overscan = nonNegativeMetric(input.overscanPx, transcriptViewportOverscanPx);
    const maximumWindowRows = positiveInteger(input.maximumWindowRows, transcriptViewportMaximumWindowRows);
    const scrollTop = input.scrollTop === null ? Math.max(0, estimatedTotalHeight - viewportHeight) : Math.min(Math.max(0, input.scrollTop), Math.max(0, estimatedTotalHeight - viewportHeight));
    const targetStart = Math.max(0, scrollTop - overscan);
    const targetEnd = Math.min(estimatedTotalHeight, scrollTop + viewportHeight + overscan);
    let windowStartIndex = this.firstIndexEndingAtOrAfter(targetStart);
    let windowEndIndex = this.lastIndexStartingAtOrBefore(targetEnd);
    if (windowEndIndex < windowStartIndex) windowEndIndex = windowStartIndex;
    if (windowEndIndex - windowStartIndex + 1 > maximumWindowRows) {
      const centerIndex = this.firstIndexEndingAtOrAfter(scrollTop + viewportHeight / 2);
      windowStartIndex = Math.max(windowStartIndex, centerIndex - Math.floor(maximumWindowRows / 2));
      windowEndIndex = Math.min(rowCount - 1, windowStartIndex + maximumWindowRows - 1);
      windowStartIndex = Math.max(0, windowEndIndex - maximumWindowRows + 1);
    }

    const renderedIndices = new Set<number>();
    for (let index = windowStartIndex; index <= windowEndIndex; index += 1) renderedIndices.add(index);
    let pinnedRowCount = 0;
    for (const rowKey of input.pinnedRowKeys ?? []) {
      const index = this.indexByKey.get(rowKey);
      if (index === undefined || renderedIndices.has(index)) continue;
      renderedIndices.add(index);
      pinnedRowCount += 1;
    }
    const ordered = [...renderedIndices].sort((left, right) => left - right);
    const slots: TranscriptViewportSlot[] = [];
    let nextIndex = 0;
    for (const index of ordered) {
      if (index > nextIndex) slots.push(this.spacer(nextIndex, index - 1));
      const rowKey = this.rowKeys[index]!;
      slots.push({ kind: 'row', key: `row:${rowKey}`, rowKey, index });
      nextIndex = index + 1;
    }
    if (nextIndex < rowCount) slots.push(this.spacer(nextIndex, rowCount - 1));
    return {
      slots,
      renderedRowCount: ordered.length,
      pinnedRowCount,
      windowStartIndex,
      windowEndIndex,
      estimatedTotalHeight,
    };
  }

  private sameKeys(next: readonly string[]): boolean {
    return this.rowKeys.length === next.length && this.rowKeys.every((key, index) => key === next[index]);
  }

  private spacer(startIndex: number, endIndex: number): TranscriptViewportSlot {
    const firstKey = this.rowKeys[startIndex] ?? String(startIndex);
    const lastKey = this.rowKeys[endIndex] ?? String(endIndex);
    return {
      kind: 'spacer',
      key: `spacer:${firstKey}:${lastKey}`,
      height: Math.max(0, this.rowEnd(endIndex) - this.rowStart(startIndex)),
      startIndex,
      endIndex,
    };
  }

  private totalHeight(): number {
    if (this.rowKeys.length === 0) return 0;
    return this.prefixHeight(this.rowKeys.length) + this.rowGap * (this.rowKeys.length - 1);
  }

  private rowStart(index: number): number {
    return this.prefixHeight(index) + this.rowGap * index;
  }

  private rowEnd(index: number): number {
    return this.rowStart(index) + (this.heights[index] ?? this.estimatedRowHeight);
  }

  private firstIndexEndingAtOrAfter(offset: number): number {
    let low = 0;
    let high = this.rowKeys.length - 1;
    let result = high;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.rowEnd(middle) >= offset) {
        result = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    return result;
  }

  private lastIndexStartingAtOrBefore(offset: number): number {
    let low = 0;
    let high = this.rowKeys.length - 1;
    let result = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.rowStart(middle) <= offset) {
        result = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return result;
  }

  private addHeight(index: number, delta: number): void {
    for (let cursor = index + 1; cursor < this.heightTree.length; cursor += cursor & -cursor) this.heightTree[cursor] += delta;
  }

  private prefixHeight(exclusiveIndex: number): number {
    let total = 0;
    for (let cursor = exclusiveIndex; cursor > 0; cursor -= cursor & -cursor) total += this.heightTree[cursor] ?? 0;
    return total;
  }
}

interface RowBinding {
  element: HTMLElement | null;
  callback: RefCallback<HTMLElement>;
}

export interface TranscriptViewportAnchor {
  rowKey: string | null;
  topOffset: number | null;
  scrollHeight: number;
  scrollTop: number;
}

export function captureTranscriptViewportAnchor(container: HTMLElement): TranscriptViewportAnchor {
  const containerRect = container.getBoundingClientRect();
  const anchorElement = [...container.querySelectorAll<HTMLElement>('.session-transcript-window-row[data-transcript-row-key]')].find((row) => {
    const rowRect = row.getBoundingClientRect();
    return rowRect.bottom >= containerRect.top && rowRect.top <= containerRect.bottom;
  });
  return {
    rowKey: anchorElement?.dataset.transcriptRowKey ?? null,
    topOffset: anchorElement ? anchorElement.getBoundingClientRect().top - containerRect.top : null,
    scrollHeight: container.scrollHeight,
    scrollTop: container.scrollTop,
  };
}

/** 历史分页和异步高度测量共用同一条稳定行补偿规则。 */
export function compensateTranscriptViewportAnchor(container: HTMLElement, anchor: TranscriptViewportAnchor): number {
  const anchorElement = anchor.rowKey ? [...container.querySelectorAll<HTMLElement>('.session-transcript-window-row[data-transcript-row-key]')].find((row) => row.dataset.transcriptRowKey === anchor.rowKey) : undefined;
  const previousScrollTop = container.scrollTop;
  if (anchorElement && anchor.topOffset !== null) {
    const nextOffset = anchorElement.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTop += nextOffset - anchor.topOffset;
  } else {
    container.scrollTop = anchor.scrollTop + (container.scrollHeight - anchor.scrollHeight);
  }
  return container.scrollTop - previousScrollTop;
}

export function useTranscriptViewportVirtualizer(input: {
  scopeKey: string | null;
  rowKeys: readonly string[];
  pinnedRowKeys: ReadonlySet<string>;
  containerRef: RefObject<HTMLElement | null>;
  isFollowingLatest?: () => boolean;
  getReadingAnchor?: () => TranscriptViewportAnchor | null;
  onFollowingLatestGeometryChange?: () => void;
  suspendAutomaticAnchor?: boolean;
}) {
  const scopeRef = useRef(input.scopeKey);
  const cacheRef = useRef(new TranscriptRowMeasurementCache());
  const layoutRef = useRef(new TranscriptViewportLayout());
  const bindingsRef = useRef(new Map<string, RowBinding>());
  const rowObserverRef = useRef<ResizeObserver | null>(null);
  const windowElementRef = useRef<HTMLElement | null>(null);
  const windowObserverRef = useRef<ResizeObserver | null>(null);
  const updateFrameRef = useRef<number | null>(null);
  const pendingViewportRef = useRef<{ scrollTop: number; viewportHeight: number } | null>(null);
  const measurementAnchorRef = useRef<TranscriptViewportAnchor | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [viewport, setViewport] = useState<{ scopeKey: string | null; scrollTop: number | null; viewportHeight: number }>({ scopeKey: input.scopeKey, scrollTop: null, viewportHeight: 720 });

  if (scopeRef.current !== input.scopeKey) {
    rowObserverRef.current?.disconnect();
    bindingsRef.current.clear();
    cacheRef.current = new TranscriptRowMeasurementCache();
    layoutRef.current = new TranscriptViewportLayout();
    measurementAnchorRef.current = null;
    scopeRef.current = input.scopeKey;
  }
  const layout = layoutRef.current;
  layout.syncKeys(input.rowKeys, cacheRef.current);

  const scheduleUpdate = useCallback(() => {
    if (updateFrameRef.current !== null) return;
    updateFrameRef.current = requestAnimationFrame(() => {
      updateFrameRef.current = null;
      const pending = pendingViewportRef.current;
      pendingViewportRef.current = null;
      if (pending) {
        setViewport({ scopeKey: scopeRef.current, scrollTop: pending.scrollTop, viewportHeight: pending.viewportHeight });
      } else {
        setLayoutRevision((revision) => revision + 1);
      }
    });
  }, []);

  const measureElement = useCallback(
    (element: HTMLElement): void => {
      const rowKey = element.dataset.transcriptRowKey;
      if (!rowKey) return;
      const height = element.getBoundingClientRect().height;
      const container = input.containerRef.current;
      const followingLatest = Boolean(input.isFollowingLatest?.());
      const candidateAnchor = !measurementAnchorRef.current && !input.suspendAutomaticAnchor && !followingLatest && container ? (input.getReadingAnchor?.() ?? captureTranscriptViewportAnchor(container)) : null;
      if (!layoutRef.current.updateMeasuredHeight(rowKey, height, cacheRef.current)) return;
      measurementAnchorRef.current ??= candidateAnchor;
      scheduleUpdate();
      if (followingLatest) input.onFollowingLatestGeometryChange?.();
    },
    [input.containerRef, input.getReadingAnchor, input.isFollowingLatest, input.onFollowingLatestGeometryChange, input.suspendAutomaticAnchor, scheduleUpdate],
  );

  useLayoutEffect(() => {
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) measureElement(entry.target as HTMLElement);
    });
    rowObserverRef.current = observer;
    for (const binding of bindingsRef.current.values()) {
      if (binding.element) observer.observe(binding.element);
    }
    return () => {
      observer.disconnect();
      if (rowObserverRef.current === observer) rowObserverRef.current = null;
    };
  }, [input.scopeKey, measureElement]);

  useLayoutEffect(() => {
    const liveKeys = new Set(input.rowKeys);
    for (const [key, binding] of bindingsRef.current) {
      if (liveKeys.has(key)) continue;
      if (binding.element) rowObserverRef.current?.unobserve(binding.element);
      bindingsRef.current.delete(key);
    }
  }, [input.rowKeys]);

  useLayoutEffect(() => {
    const container = input.containerRef.current;
    if (!container) return;
    setViewport((current) => ({
      scopeKey: input.scopeKey,
      scrollTop: current.scopeKey === input.scopeKey ? current.scrollTop : null,
      viewportHeight: positiveMetric(container.clientHeight, current.viewportHeight),
    }));
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      setViewport((current) => ({ ...current, viewportHeight: positiveMetric(container.clientHeight, current.viewportHeight) }));
      if (input.isFollowingLatest?.()) input.onFollowingLatestGeometryChange?.();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [input.containerRef, input.isFollowingLatest, input.onFollowingLatestGeometryChange, input.scopeKey]);

  useLayoutEffect(() => {
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      if (input.isFollowingLatest?.()) input.onFollowingLatestGeometryChange?.();
    });
    windowObserverRef.current = observer;
    if (windowElementRef.current) observer.observe(windowElementRef.current);
    return () => {
      observer.disconnect();
      if (windowObserverRef.current === observer) windowObserverRef.current = null;
    };
  }, [input.isFollowingLatest, input.onFollowingLatestGeometryChange, input.scopeKey]);

  useLayoutEffect(
    () => () => {
      if (updateFrameRef.current !== null) cancelAnimationFrame(updateFrameRef.current);
    },
    [],
  );

  const rowRef = useCallback(
    (rowKey: string): RefCallback<HTMLElement> => {
      const existing = bindingsRef.current.get(rowKey);
      if (existing) return existing.callback;
      const binding: RowBinding = {
        element: null,
        callback: (element) => {
          if (binding.element) rowObserverRef.current?.unobserve(binding.element);
          binding.element = element;
          if (!element) {
            bindingsRef.current.delete(rowKey);
            return;
          }
          bindingsRef.current.set(rowKey, binding);
          measureElement(element);
          rowObserverRef.current?.observe(element);
        },
      };
      bindingsRef.current.set(rowKey, binding);
      return binding.callback;
    },
    [measureElement],
  );

  const synchronizeViewport = useCallback(
    (container: HTMLElement): void => {
      pendingViewportRef.current = { scrollTop: container.scrollTop, viewportHeight: positiveMetric(container.clientHeight, 720) };
      scheduleUpdate();
    },
    [scheduleUpdate],
  );

  const windowRef = useCallback((element: HTMLElement | null): void => {
    if (windowElementRef.current) windowObserverRef.current?.unobserve(windowElementRef.current);
    windowElementRef.current = element;
    if (element) windowObserverRef.current?.observe(element);
  }, []);

  const effectiveViewport = viewport.scopeKey === input.scopeKey ? viewport : { scopeKey: input.scopeKey, scrollTop: null, viewportHeight: 720 };
  const projection = useMemo(() => {
    const anchorRowKey = measurementAnchorRef.current?.rowKey;
    const pinnedRowKeys = anchorRowKey ? new Set([...input.pinnedRowKeys, anchorRowKey]) : input.pinnedRowKeys;
    return layout.project({
      scrollTop: effectiveViewport.scrollTop,
      viewportHeight: effectiveViewport.viewportHeight,
      pinnedRowKeys,
    });
  }, [effectiveViewport.scrollTop, effectiveViewport.viewportHeight, input.pinnedRowKeys, input.rowKeys, layout, layoutRevision]);

  useLayoutEffect(() => {
    // 行测量会先修改高度树、再提交新的 spacer/窗口投影。必须在投影真正进入 DOM 后
    // 再通知一次底部跟随，否则首次请求只会滚到旧 scrollHeight 的底部。
    if (input.isFollowingLatest?.()) input.onFollowingLatestGeometryChange?.();
  }, [input.isFollowingLatest, input.onFollowingLatestGeometryChange, projection]);

  useLayoutEffect(() => {
    const anchor = measurementAnchorRef.current;
    const container = input.containerRef.current;
    if (!anchor || !container) return;
    measurementAnchorRef.current = null;
    if (input.suspendAutomaticAnchor || input.isFollowingLatest?.()) return;
    compensateTranscriptViewportAnchor(container, anchor);
    pendingViewportRef.current = { scrollTop: container.scrollTop, viewportHeight: positiveMetric(container.clientHeight, 720) };
    scheduleUpdate();
  }, [input.containerRef, input.isFollowingLatest, input.suspendAutomaticAnchor, projection, scheduleUpdate]);

  return {
    projection,
    windowRef,
    rowRef,
    rowElement: (rowKey: string): HTMLElement | null => bindingsRef.current.get(rowKey)?.element ?? null,
    synchronizeViewport,
    measurementCacheSize: cacheRef.current.size,
  };
}

function positiveMetric(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback;
}

function nonNegativeMetric(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 0 ? (value as number) : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}
