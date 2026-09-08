import type { NativeQueuedSubmission, NativeQueueSnapshot } from './sessionTypes.js';

/** 沿用提交的稳定队列顺序，保留模型接手前的消息气泡。 */
export function visibleQueuedSubmissions(queue: NativeQueueSnapshot | null): NativeQueuedSubmission[] {
  return [...(queue?.submissions ?? [])]
    .filter((submission) => (submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'steering' || submission.status === 'paused') && !submission.providerTurnId)
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
