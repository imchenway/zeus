import type { NativeQueuedSubmission, NativeQueueSnapshot, NativeSessionItemBuffer, NativeSessionState } from './sessionTypes.js';

/** 输入框排队区同时承载权威提交和等待服务端接纳的本地投影。 */
export interface ComposerQueuedSubmission extends NativeQueuedSubmission {
  /** 本地投影尚无权威队列记录，只能展示，不能执行编辑、引导、删除或排序。 */
  localOnly: boolean;
}

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
      // 已接纳历史已经由持久显示位置排好，队列层不得跨来源再次排序。
      return 0;
    }
    if (leftPosition === undefined) return -1;
    if (rightPosition === undefined) return 1;
    /** 同时等待本地回执时按首次显示时间排序，状态更新时间不能移动气泡。 */
    return leftPosition - rightPosition || (left.timelineAt ?? '').localeCompare(right.timelineAt ?? '');
  });
}

/** 沿用提交的稳定队列顺序，保留模型接手前的消息及发送失败后的重试入口。 */
export function visibleQueuedSubmissions(queue: NativeQueueSnapshot | null): NativeQueuedSubmission[] {
  return [...(queue?.submissions ?? [])]
    .filter(
      (submission) =>
        submission.status === 'paused' ||
        submission.status === 'active' ||
        submission.status === 'dispatching' ||
        ((submission.status === 'queued' || submission.status === 'steering' || submission.status === 'failed') && !submission.providerTurnId),
    )
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

/** 输入框卡片立即接管活跃轮次后的本地消息；权威队列到达后再开放操作。 */
export function composerQueuedSubmissions(state: NativeSessionState): ComposerQueuedSubmission[] {
  /** 已落库的普通等待项保持服务端顺序与完整操作能力。 */
  const durable = visibleQueuedSubmissions(state.queue)
    .filter(
      (submission) =>
        !submission.controlAction &&
        !submission.providerTurnId &&
        (submission.status === 'queued' || submission.status === 'paused') &&
        submission.pausedReason !== 'outcome_unknown' &&
        submission.pausedReason !== 'recovery_required' &&
        submission.pausedReason !== 'recovered_unsent' &&
        !submission.error?.recoveryRequired &&
        isSubmissionWaitingInQueue(state.queue, submission),
    )
    .map((submission) => ({ ...submission, localOnly: false }));
  /** 所有权威提交身份用于在实时事件到达时原位替换本地投影。 */
  const durableSubmissionIds = new Set((state.queue?.submissions ?? []).map((submission) => submission.id));
  /** 客户端身份覆盖 HTTP 回执和队列事件到达次序不同的情况。 */
  const durableClientMessageIds = new Set((state.queue?.submissions ?? []).map((submission) => submission.clientUserMessageId).filter((value): value is string => Boolean(value)));
  /** 本地投影沿用消息首次加入 itemOrder 的顺序，避免状态更新时间改变排队位置。 */
  const local = state.itemOrder.flatMap((key, index): ComposerQueuedSubmission[] => {
    /** 只读取当前稳定条目，不为已经清理的顺序占位生成空卡片。 */
    const item = state.items[key];
    if (!item || !item.optimistic || item.type !== 'userMessage' || item.payload.delivery !== 'queue' || item.payload.queuedForActiveTurn !== true) return [];
    if (item.status !== 'pending' && item.status !== 'queued') return [];
    /** 本地客户端身份是等待接纳期间唯一可依赖的去重键。 */
    const clientUserMessageId = item.clientUserMessageId ?? item.durableClientUserMessageId;
    if (!clientUserMessageId || durableClientMessageIds.has(clientUserMessageId)) return [];
    /** HTTP 回执可能先补齐 submissionId；实时队列随后到达时同样不得重复展示。 */
    const submissionId = typeof item.payload.submissionId === 'string' ? item.payload.submissionId : null;
    if (submissionId && durableSubmissionIds.has(submissionId)) return [];
    /** 附件来自本地冻结的发送信封，只用于首帧展示，不作为权威操作参数。 */
    const attachments = Array.isArray(item.payload.attachments) ? (item.payload.attachments as NativeQueuedSubmission['attachments']) : undefined;
    return [
      {
        id: clientUserMessageId,
        conversationId: item.conversationId,
        content: item.text,
        composerDraft: item.text,
        status: item.status,
        delivery: 'queue',
        ...(attachments?.length ? { attachments } : {}),
        clientUserMessageId,
        position: durable.length + index + 1,
        providerTurnId: null,
        pausedReason: null,
        createdAt: item.messageCreatedAt,
        updatedAt: item.updatedAt,
        localOnly: true,
      },
    ];
  });
  return [...durable, ...local];
}

/** 服务端重排要求完整提交 queued、paused 和 failed 成员，视图不能只传当前可见卡片。 */
export function reorderableQueuedSubmissions(queue: NativeQueueSnapshot | null): NativeQueuedSubmission[] {
  return visibleQueuedSubmissions(queue).filter((submission) => submission.status === 'queued' || submission.status === 'paused' || submission.status === 'failed');
}
