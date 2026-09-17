import type { ConversationTranscriptEnvelope } from '@zeus/shared';
import type { NativeItemSnapshot } from './sessionTypes.js';

/** 一次统一合并的可观察结果，供快照接管决定最小刷新范围。 */
export interface TranscriptReconciliationResult {
  /** 按持久位置排列的完整条目。 */
  items: NativeItemSnapshot[];
  /** 内容或状态实际变化的显示身份。 */
  changedEntryIds: string[];
  /** 位置变化导致顺序改变的显示身份。 */
  movedEntryIds: string[];
}

/** 快照、实时和分页唯一允许的条目合并入口。 */
export function reconcileTranscriptItems(current: readonly NativeItemSnapshot[], incoming: readonly NativeItemSnapshot[]): TranscriptReconciliationResult {
  /** 显示身份而非来源行身份决定 React 条目是否复用。 */
  const byEntryId = new Map<string, NativeItemSnapshot>();
  /** 记录原位置，区分内容变化和真实移动。 */
  const previousOrder = new Map(current.map((item, index) => [transcriptEntryId(item), index]));
  /** 只收集发生有效变化的显示身份。 */
  const changedEntryIds = new Set<string>();
  /** 同一来源的旧事件不能覆盖新快照。 */
  const add = (item: NativeItemSnapshot): void => {
    const entryId = transcriptEntryId(item);
    const previous = byEntryId.get(entryId);
    if (!previous) {
      byEntryId.set(entryId, item);
      if (!previousOrder.has(entryId)) changedEntryIds.add(entryId);
      return;
    }
    const merged = mergeTranscriptItem(previous, item);
    byEntryId.set(entryId, merged);
    if (merged !== previous) changedEntryIds.add(entryId);
  };
  current.forEach(add);
  incoming.forEach(add);
  /** 只有新增或位置变化才排序；普通正文更新沿用已有顺序。 */
  const structuralChange =
    byEntryId.size !== current.length ||
    current.some((item) => {
      const next = byEntryId.get(transcriptEntryId(item))!;
      return next.transcript.placement.order !== item.transcript.placement.order;
    });
  const items = changedEntryIds.size === 0 ? (current as NativeItemSnapshot[]) : [...byEntryId.values()];
  if (structuralChange) items.sort(compareTranscriptItems);
  const movedEntryIds = items.flatMap((item, index) => {
    const entryId = transcriptEntryId(item);
    const before = previousOrder.get(entryId);
    return before !== undefined && before !== index ? [entryId] : [];
  });
  return { items, changedEntryIds: [...changedEntryIds], movedEntryIds };
}

/** 只按服务端持久位置排序；时间戳、分页序号和到达顺序均不参与。 */
export function compareTranscriptItems(left: NativeItemSnapshot, right: NativeItemSnapshot): number {
  const leftOrder = left.transcript.placement.order;
  const rightOrder = right.transcript.placement.order;
  if (leftOrder === null && rightOrder !== null) return 1;
  if (leftOrder !== null && rightOrder === null) return -1;
  if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) return leftOrder - rightOrder;
  return transcriptEntryId(left).localeCompare(transcriptEntryId(right));
}

/** 读取条目的产品级稳定身份。 */
export function transcriptEntryId(item: Pick<NativeItemSnapshot, 'transcript'>): string {
  return item.transcript.placement.entryId;
}

/** 统一合并器只依赖内容、状态和来源证据，供快照与实时缓冲共同使用。 */
type TranscriptContent = Pick<NativeItemSnapshot, 'text' | 'payload' | 'status'> & { transcript?: ConversationTranscriptEnvelope };

/** 来源修订用于去重；正文权威只由实际载荷的内容修订决定。 */
export function mergeTranscriptItem<T extends TranscriptContent>(previous: T, incoming: T): T {
  const previousRevision = transcriptContentRevision(previous.transcript);
  const incomingRevision = transcriptContentRevision(incoming.transcript);
  const previousComplete = previous.payload.v2ContentTruncated !== true;
  const incomingComplete = incoming.payload.v2ContentTruncated !== true;
  const keepContent =
    incomingRevision < previousRevision || (incomingRevision === previousRevision && ((previousComplete && !incomingComplete) || (previous.payload.v2ContentKind === 'process_detail' && incoming.payload.v2ContentKind !== 'process_detail')));
  const content = keepContent ? previous : incoming;
  const placement = newestTranscriptPlacement(previous.transcript, incoming.transcript);
  const transcript = content.transcript && placement ? { ...content.transcript, placement } : (content.transcript ?? incoming.transcript);
  if (content === previous && transcript?.placement === previous.transcript?.placement) return previous;
  return {
    ...incoming,
    text: content.text,
    payload: content.payload,
    status: terminalStatus(previous.status, content.status),
    ...(transcript ? { transcript } : {}),
  };
}

/** 正文携带的来源集合只描述实际采用的载荷，不能混入更晚的其他副本。 */
export function transcriptContentRevision(envelope: ConversationTranscriptEnvelope | undefined): number {
  return envelope ? Math.max(0, ...envelope.sources.map((source) => source.contentRevision)) : 0;
}

/** 位置独立于正文合并，旧正文也可以携带新的位置证据。 */
export function newestTranscriptPlacement(previous: ConversationTranscriptEnvelope | undefined, incoming: ConversationTranscriptEnvelope | undefined): ConversationTranscriptEnvelope['placement'] | undefined {
  if (!previous) return incoming?.placement;
  if (!incoming) return previous.placement;
  return incoming.placement.orderEpoch > previous.placement.orderEpoch || (incoming.placement.orderEpoch === previous.placement.orderEpoch && incoming.placement.placementRevision >= previous.placement.placementRevision)
    ? incoming.placement
    : previous.placement;
}

/** 条目完成后不能被较晚到达的进行中投影倒退。 */
function terminalStatus(previous: string, incoming: string): string {
  return (previous === 'completed' || previous === 'failed' || previous === 'resolved') && (incoming === 'in_progress' || incoming === 'running') ? previous : incoming;
}
