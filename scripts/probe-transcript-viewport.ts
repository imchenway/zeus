import { TranscriptRowMeasurementCache, TranscriptViewportLayout, transcriptViewportMaximumWindowRows, transcriptViewportMeasurementCacheLimit } from '../apps/desktop/src/renderer/session/transcriptViewportVirtualizer.js';
import { rememberSessionHotState, sessionHotCacheByteLimit, sessionHotCacheEntryByteLimit, type SessionHotCache } from '../apps/desktop/src/renderer/session/sessionHotCache.js';
import type { NativeSessionState } from '../apps/desktop/src/renderer/session/sessionTypes.js';

const rowCount = 100_000;
const rowKeys = Array.from({ length: rowCount }, (_, index) => `row-${index}`);
const measurements = new TranscriptRowMeasurementCache();
for (let index = 0; index < 10_000; index += 1) measurements.remember(`row-${index}`, 96 + (index % 73));

const layout = new TranscriptViewportLayout();
layout.syncKeys(rowKeys, measurements);
const pinnedRowKeys = new Set(['row-0', 'row-50000', 'row-99999']);
const middleProjection = layout.project({
  scrollTop: 7_300_000,
  viewportHeight: 900,
  pinnedRowKeys,
});
const middleProjectedKeys = projectedKeys(middleProjection.slots);

assertProbe(measurements.size === transcriptViewportMeasurementCacheLimit, '变高行测量缓存必须按上限淘汰');
assertProbe(middleProjection.renderedRowCount <= transcriptViewportMaximumWindowRows + pinnedRowKeys.size, '视口窗口只能附加显式保留行');
assertProbe(
  [...pinnedRowKeys].every((key) => middleProjectedKeys.has(key)),
  '活动、展开或焦点保留行不能被窗口淘汰',
);
assertProbe(middleProjection.slots.length <= middleProjection.renderedRowCount * 2 + 1, '占位与行节点数量必须随窗口而不是随历史总量增长');

const prependLayout = new TranscriptViewportLayout();
const oldKeys = rowKeys.slice(50_000);
const frozenAnchorKey = 'row-75000';
prependLayout.syncKeys(oldKeys, measurements);
const oldScrollTop = 25_000 * 146;
const beforePrepend = prependLayout.project({ scrollTop: oldScrollTop, viewportHeight: 900 });
assertProbe(projectedKeys(beforePrepend.slots).has(frozenAnchorKey), '前插前的视口锚点必须已挂载');
prependLayout.syncKeys(rowKeys, measurements);
const afterPrepend = prependLayout.project({ scrollTop: oldScrollTop, viewportHeight: 900, pinnedRowKeys: new Set([frozenAnchorKey]) });
assertProbe(projectedKeys(afterPrepend.slots).has(frozenAnchorKey), '冻结游标返回更早页后，稳定锚点必须继续挂载以校准 scrollTop');
assertProbe(afterPrepend.renderedRowCount <= transcriptViewportMaximumWindowRows + 1, '历史前插不能把中间全部行重新挂入 DOM');

const appendedKeys = [...rowKeys, 'row-100000'];
layout.syncKeys(appendedKeys, measurements);
const tailProjection = layout.project({ scrollTop: null, viewportHeight: 900, pinnedRowKeys: new Set(['row-100000']) });
assertProbe(projectedKeys(tailProjection.slots).has('row-100000'), '尾部增量必须进入尾部窗口');
assertProbe(tailProjection.renderedRowCount <= transcriptViewportMaximumWindowRows + 1, '尾部增量不能重建完整历史 DOM');

const hotCache: SessionHotCache = new Map();
const boundedEntryPayload = 'x'.repeat(3 * 1024 * 1024);
for (let index = 0; index < 6; index += 1) {
  const conversationId = `conversation-${index}`;
  rememberSessionHotState(hotCache, conversationId, probeSessionState(conversationId, boundedEntryPayload));
}
const cachedBytes = [...hotCache.values()].reduce((total, entry) => total + entry.estimatedBytes, 0);
assertProbe(cachedBytes <= sessionHotCacheByteLimit, '会话数未超限时也必须执行总字节淘汰');
assertProbe(
  [...hotCache.values()].every((entry) => Boolean(entry.state.snapshot?.v2Paging?.history.nextCursor)),
  '保留的 UI 热状态必须携带 V2 冻结历史游标',
);

const oversizedConversationId = 'conversation-oversized';
rememberSessionHotState(hotCache, oversizedConversationId, probeSessionState(oversizedConversationId, 'y'.repeat(sessionHotCacheEntryByteLimit / 2 + 1024)));
assertProbe(!hotCache.has(oversizedConversationId), '超过单会话字节上限的状态必须直接放弃并由 Snapshot V2 重建');

console.log(
  JSON.stringify(
    {
      status: 'passed',
      observed: {
        totalRows: rowCount,
        middleProjectedRows: middleProjection.renderedRowCount,
        middleProjectionSlots: middleProjection.slots.length,
        measurementCacheEntries: measurements.size,
        prependProjectedRows: afterPrepend.renderedRowCount,
        tailProjectedRows: tailProjection.renderedRowCount,
        retainedHotSessions: hotCache.size,
        retainedHotBytes: cachedBytes,
        hotByteLimit: sessionHotCacheByteLimit,
      },
    },
    null,
    2,
  ),
);

function projectedKeys(slots: ReturnType<TranscriptViewportLayout['project']>['slots']): Set<string> {
  return new Set(slots.flatMap((slot) => (slot.kind === 'row' ? [slot.rowKey] : [])));
}

function probeSessionState(conversationId: string, payload: string): NativeSessionState {
  return {
    conversationId,
    conversationState: 'idle',
    pendingRequests: [],
    planImplementationRequests: [],
    queue: null,
    snapshot: {
      id: conversationId,
      projectId: 'probe-project',
      v2Paging: {
        history: { nextCursor: `frozen:${conversationId}`, hasMore: true, loading: false, error: null, loadedThroughSequence: null, oldestLoadedSequence: null },
      },
    },
    probePayload: payload,
  } as unknown as NativeSessionState;
}

function assertProbe(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Renderer 长历史行为探针失败：${message}`);
}
