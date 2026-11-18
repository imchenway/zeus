import type { NativeQueuedSubmission, NativeQueueSnapshot, NativeSessionItemBuffer, NativeSessionState } from './sessionTypes.js';

/** 输入框排队区同时承载权威提交和等待服务端接纳的本地投影。 */
export interface ComposerQueuedSubmission extends NativeQueuedSubmission {
  /** 本地投影使用客户端消息身份，操作发出前由控制器查找权威提交。 */
  localOnly: boolean;
}

/** 客户端消息身份在发送回执接管卡片时保持稳定。 */
export function queuedSubmissionIdentity(submission: NativeQueuedSubmission): string {
  return submission.clientUserMessageId || submission.id;
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

/** 轮次结束事件可以先于队列刷新；旧 active 状态不能把下一条输入误放进排队区。 */
export function hasUnfinishedConversationTurn(state: NativeSessionState): boolean {
  /** 队列派发还没有轮次身份，但后续输入确实需要等待。 */
  const queueState = state.queue?.state;
  if (queueState?.type === 'dispatching') return true;
  /** 实时轮次和队列可能交错到达，终态身份对两种来源同样有效。 */
  const turnIds = [state.activeTurnId, queueState?.type === 'active' || queueState?.type === 'waiting' ? queueState.turnId : null];
  return turnIds.some((id) => Boolean(id && !state.terminalTurnIds[id]));
}

/** 只有等待未结束轮次或前序消息的提交才展示排队，首条消息的准备状态留在用户气泡。 */
export function isSubmissionWaitingInQueue(state: NativeSessionState, submission: NativeQueuedSubmission | null): boolean {
  /** 提交和轮次终态必须来自同一份显示快照。 */
  const queue = state.queue;
  if (!queue || !submission || submission.providerTurnId) return false;
  // 失败与送达待核对属于原用户气泡，不能被暂停状态重新归入排队区。
  if (submission.error || ['outcome_unknown', 'recovery_required', 'recovered_unsent', 'preflight_failed', 'runtime_rejected'].includes(submission.pausedReason ?? '')) return false;
  // 用户中断后的待发队首保留原有继续入口，准备和恢复暂停不把首条消息移出正文。
  if (submission.status === 'paused' && submission.pausedReason === 'interrupted') return true;
  if (submission.status !== 'queued' && submission.status !== 'paused') return false;
  if (queue.state.type === 'dispatching') return queue.state.submissionId !== submission.id;
  /** 已完成轮次留下的旧提交不再占据等待队首；未知送达和明确暂停仍保留。 */
  const firstWaiting = visibleQueuedSubmissions(queue).find((candidate) => !candidate.providerTurnId || !state.terminalTurnIds[candidate.providerTurnId]);
  return hasUnfinishedConversationTurn(state) || firstWaiting?.id !== submission.id;
}

/** 输入框卡片立即接管活跃轮次后的本地消息。 */
export function composerQueuedSubmissions(state: NativeSessionState): ComposerQueuedSubmission[] {
  /** 排队区不会在关闭或失败的 Provider 下渲染；此时消息必须回到正文，不能被互斥规则隐藏。 */
  if (state.snapshot?.providerState === 'failed' || state.snapshot?.providerState === 'closed') return [];
  /** 已落库的普通等待项保持服务端顺序与完整操作能力。 */
  const durable = visibleQueuedSubmissions(state.queue)
    .filter((submission) => !submission.internalOperation && !submission.controlAction && isSubmissionWaitingInQueue(state, submission))
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
    // 首次提交已冻结等待关系；轮次尚未建立或已结束时，仍由权威提交回执接管，不能提前退回正文。
    if ((item.status !== 'pending' && item.status !== 'queued') || item.payload.deliveryError || item.payload.error) return [];
    /** 本地客户端身份是等待接纳期间唯一可依赖的去重键。 */
    const clientUserMessageId = item.clientUserMessageId ?? item.durableClientUserMessageId;
    if (!clientUserMessageId || durableClientMessageIds.has(clientUserMessageId)) return [];
    /** HTTP 回执可能先补齐 submissionId；实时队列随后到达时同样不得重复展示。 */
    const submissionId = typeof item.payload.submissionId === 'string' ? item.payload.submissionId : null;
    if (submissionId && durableSubmissionIds.has(submissionId)) return [];
    /** 附件来自本地冻结的发送信封，用于首帧展示和编辑初值。 */
    const attachments = Array.isArray(item.payload.attachments) ? (item.payload.attachments as NativeQueuedSubmission['attachments']) : undefined;
    return [
      {
        id: clientUserMessageId,
        conversationId: item.conversationId,
        content: item.text,
        composerDraft: typeof item.payload.composerDraft === 'string' ? item.payload.composerDraft : item.text,
        status: 'queued',
        delivery: 'queue',
        ...(attachments?.length ? { attachments } : {}),
        /** 首帧保留原题关系，权威队列接管前同样可以显示答案摘要。 */
        ...(item.payload.questionAnswer ? { questionAnswer: item.payload.questionAnswer as NativeQueuedSubmission['questionAnswer'] } : {}),
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
