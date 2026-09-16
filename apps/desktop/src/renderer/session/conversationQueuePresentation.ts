import type { NativeQueuedSubmission, NativeQueueSnapshot, NativeSessionItemBuffer } from './sessionTypes.js';

/** 仅未确认接纳的本地消息进入待发区域；等待原生回显不等于仍在排队。 */
export function isUnacceptedTranscriptMessage(item: NativeSessionItemBuffer): boolean {
  if (!item.optimistic || item.providerItemId || item.status === 'active' || item.status === 'completed' || item.status === 'resolved') return false;
  // 已交给当前轮次的引导消息沿用发言位置，不能等待原生回显才退出队尾。
  return !(item.payload.delivery === 'steer_now' && item.status === 'steering');
}

/** 待发送消息按权威队列顺序放在记录末尾，恢复时不会被提交时间插回旧回复之前。 */
export function orderTranscriptItemsWithQueue(items: readonly NativeSessionItemBuffer[], queue: NativeQueueSnapshot | null): NativeSessionItemBuffer[] {
  /** 提交与客户端消息身份共同覆盖本地气泡和冷开队列投影。 */
  const positions = new Map<string, number>();
  /** 失败提交仍占据原发送位置；已结束历史则由条目的原生身份排除。 */
  const submissions = [...(queue?.submissions ?? [])].sort((left, right) => left.position - right.position || (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id));
  submissions.forEach((submission, index) => {
    positions.set(submission.id, index);
    if (submission.clientUserMessageId) positions.set(submission.clientUserMessageId, index);
  });
  /** 排序与失败记录插入共用接纳判断，避免两种展示各自把旧输入推向队尾。 */
  const queuePosition = (item: NativeSessionItemBuffer): number | undefined => {
    if (!isUnacceptedTranscriptMessage(item)) return undefined;
    for (const id of [item.payload.submissionId, item.clientUserMessageId, item.durableClientUserMessageId]) {
      if (typeof id === 'string' && positions.has(id)) return positions.get(id);
    }
    // 本地消息尚无队列回执时，也必须排在既有待发消息之后。
    return submissions.length;
  };
  return [...items].sort((left, right) => {
    /** 已有队列身份和等待本地回执的消息统一在历史末尾排序。 */
    const leftPosition = queuePosition(left);
    /** 同时比较两端，保证已确认历史位于待发队列之前。 */
    const rightPosition = queuePosition(right);
    if (leftPosition === undefined && rightPosition === undefined) {
      // 同时落盘仍按持久序号区分先后，其他历史沿用上游顺序。
      if ((left.timelineAt ?? left.updatedAt) === (right.timelineAt ?? right.updatedAt) && typeof left.payload.v2Sequence === 'number' && typeof right.payload.v2Sequence === 'number')
        return left.payload.v2Sequence - right.payload.v2Sequence;
      return 0;
    }
    if (leftPosition === undefined) return -1;
    if (rightPosition === undefined) return 1;
    /** 同时等待本地回执时按首次显示时间排序，状态更新时间不能移动气泡。 */
    return leftPosition - rightPosition || (left.timelineAt ?? '').localeCompare(right.timelineAt ?? '');
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
