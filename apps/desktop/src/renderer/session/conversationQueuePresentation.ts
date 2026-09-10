import type { NativeQueuedSubmission, NativeQueueSnapshot, NativeSessionItemBuffer } from './sessionTypes.js';

/** 待发送消息按权威队列顺序放在记录末尾，恢复时不会被提交时间插回旧回复之前。 */
export function orderTranscriptItemsWithQueue(items: readonly NativeSessionItemBuffer[], queue: NativeQueueSnapshot | null): NativeSessionItemBuffer[] {
  /** 提交与客户端消息身份共同覆盖本地气泡和冷开队列投影。 */
  const positions = new Map<string, number>();
  visibleQueuedSubmissions(queue).forEach((submission, index) => {
    positions.set(submission.id, index);
    if (submission.clientUserMessageId) positions.set(submission.clientUserMessageId, index);
  });
  /** 已有原生消息身份的条目仍属于真实历史，不能被陈旧队列状态挪到末尾。 */
  const queuePosition = (item: NativeSessionItemBuffer): number | undefined => {
    if (!item.optimistic || item.providerItemId) return undefined;
    for (const id of [item.payload.submissionId, item.clientUserMessageId, item.durableClientUserMessageId]) {
      if (typeof id === 'string' && positions.has(id)) return positions.get(id);
    }
    return undefined;
  };
  return [...items].sort((left, right) => {
    /** 有明确队列身份时优先按队列定位，其他条目沿用真实时间。 */
    const leftPosition = queuePosition(left);
    /** 同时比较两端，保证已确认历史位于待发队列之前。 */
    const rightPosition = queuePosition(right);
    if (leftPosition !== undefined || rightPosition !== undefined) return leftPosition === undefined ? -1 : rightPosition === undefined ? 1 : leftPosition - rightPosition;
    /** 同一毫秒的持久历史按既有顺序排列，避免答复被技术 key 排到提问前。 */
    const chronological = (left.timelineAt ?? left.updatedAt ?? '').localeCompare(right.timelineAt ?? right.updatedAt ?? '');
    if (chronological) return chronological;
    if (typeof left.payload.v2Sequence === 'number' && typeof right.payload.v2Sequence === 'number' && left.payload.v2Sequence !== right.payload.v2Sequence) return left.payload.v2Sequence - right.payload.v2Sequence;
    return left.key.localeCompare(right.key);
  });
}

/** 沿用提交的稳定队列顺序，保留模型接手前的消息气泡。 */
export function visibleQueuedSubmissions(queue: NativeQueueSnapshot | null): NativeQueuedSubmission[] {
  return [...(queue?.submissions ?? [])]
    .filter((submission) => submission.status === 'paused' || ((submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'steering') && !submission.providerTurnId))
    .sort((left, right) => left.position - right.position || (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id));
}

/** 只有被当前轮次、前序消息或明确等待原因阻塞的提交才展示排队；空闲队首正在交接发送。 */
export function isSubmissionWaitingInQueue(queue: NativeQueueSnapshot | null, submission: NativeQueuedSubmission | null): boolean {
  if (!queue || !submission || submission.providerTurnId) return false;
  if (submission.status === 'paused') return true;
  if (submission.status !== 'queued') return false;
  if (queue.state.type === 'dispatching') return queue.state.submissionId !== submission.id;
  return queue.state.type !== 'idle' || Boolean(queue.waitReason && queue.waitReason !== 'dispatch_pending') || visibleQueuedSubmissions(queue)[0]?.id !== submission.id;
}
