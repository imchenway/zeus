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
  const items = [...byEntryId.values()].sort(compareTranscriptItems);
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

/** 同一显示条目按来源修订合并，过程详情和完整正文不会被轻量预览降级。 */
function mergeTranscriptItem(previous: NativeItemSnapshot, incoming: NativeItemSnapshot): NativeItemSnapshot {
  if (incoming.transcript.placement.orderEpoch < previous.transcript.placement.orderEpoch) return previous;
  if (incoming.transcript.placement.orderEpoch === previous.transcript.placement.orderEpoch && sourceRevision(incoming.transcript) < sourceRevision(previous.transcript)) return previous;
  if (previous.payload.v2ContentKind === 'process_detail' && incoming.payload.v2ContentKind !== 'process_detail') {
    return {
      ...previous,
      status: terminalStatus(previous.status, incoming.status),
      completedAt: incoming.completedAt ?? previous.completedAt,
      updatedAt: incoming.updatedAt > previous.updatedAt ? incoming.updatedAt : previous.updatedAt,
      transcript: newestEnvelope(previous.transcript, incoming.transcript),
      payload: { ...incoming.payload, ...previous.payload },
    };
  }
  /** Pi 的调用和结果分开到达时保留参数、正文句柄与最终结果。 */
  if (previous.payload.provider === 'pi' && incoming.payload.provider === 'pi') {
    return {
      ...incoming,
      startedAt: previous.startedAt ?? incoming.startedAt,
      status: terminalStatus(previous.status, incoming.status),
      transcript: newestEnvelope(previous.transcript, incoming.transcript),
      payload: {
        ...previous.payload,
        ...incoming.payload,
        toolResult: incoming.payload.toolResult ?? previous.payload.toolResult,
        ...(previous.payload.command && previous.payload.v2ContentTruncated === true && !incoming.payload.command
          ? { v2ContentHandle: previous.payload.v2ContentHandle, v2ContentTruncated: true, v2ContentBytes: previous.payload.v2ContentBytes }
          : {}),
      },
    };
  }
  return { ...incoming, status: terminalStatus(previous.status, incoming.status), transcript: newestEnvelope(previous.transcript, incoming.transcript) };
}

/** 条目完成后不能被较晚到达的进行中投影倒退。 */
function terminalStatus(previous: string, incoming: string): string {
  return previous === 'completed' || previous === 'failed' || previous === 'resolved' ? previous : incoming;
}

/** 位置取新代次和新修订，来源集合按来源身份保留最高修订。 */
function newestEnvelope(previous: ConversationTranscriptEnvelope, incoming: ConversationTranscriptEnvelope): ConversationTranscriptEnvelope {
  const placement =
    incoming.placement.orderEpoch > previous.placement.orderEpoch || incoming.placement.placementRevision >= previous.placement.placementRevision ? incoming.placement : previous.placement;
  const sources = new Map<string, ConversationTranscriptEnvelope['sources'][number]>();
  for (const source of [...previous.sources, ...incoming.sources]) {
    const key = `${source.domain}\u0000${source.scope}\u0000${source.sourceId}\u0000${source.facet}`;
    const current = sources.get(key);
    if (!current || source.revision > current.revision) sources.set(key, source);
  }
  return { placement, sources: [...sources.values()] };
}

/** 比较一条投影采用的最高来源修订。 */
function sourceRevision(envelope: ConversationTranscriptEnvelope): number {
  return Math.max(envelope.placement.placementRevision, ...envelope.sources.map((source) => source.revision));
}
