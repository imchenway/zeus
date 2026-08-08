import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isOperationalActivityItem, SessionActivityGroup, SessionTurnDuration } from './SessionActivity.js';
import { itemRole, type SessionUiLanguage, ThreadItemView, transcriptItemText } from './ThreadItemView.js';
import { PlanSummary } from './PlanSummary.js';
import type { ConversationResource, ConversationResourcePreview, NativePendingRequest, NativeSessionItemBuffer, NativeSessionState, NativeTurnFailureSnapshot, TurnChangeSet, TurnChangeSetOperationResult } from './sessionTypes.js';
import type { ConversationFileLocation, ConversationOpenTarget } from '@zeus/shared';
import { useThreadScrollController } from './useThreadScrollController.js';
import { TurnChangeCard } from './TurnChanges.js';
import { visibleQueuedSubmissions } from './QueuedConversationMessages.js';
import { latestReasoningItemsByTurn, reasoningSummaryStatus, SessionReasoningSummary } from './SessionReasoningSummary.js';
import { AnsweredRequestHistory, isAnsweredUserInputRequest } from './AnsweredRequestHistory.js';

export interface ConversationTranscriptProps {
  state: NativeSessionState;
  language: SessionUiLanguage;
  onEditUserItem?: (item: NativeSessionItemBuffer, content: string) => void | Promise<void>;
  onRetryItem?: (item: NativeSessionItemBuffer) => void;
  openPlanItemId?: string | null;
  onOpenPlan?: (item: NativeSessionItemBuffer) => void;
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
  onReviewTurnChanges?: (changeSet: TurnChangeSet, fileId?: string) => void;
  onOperateTurnChangeSet?: (changeSet: TurnChangeSet, action: 'undo' | 'reapply') => Promise<TurnChangeSetOperationResult>;
}

export function ConversationTranscript(props: ConversationTranscriptProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const previousTurnIdRef = useRef<string | null>(null);
  const pendingTurnPositionRef = useRef(false);
  const scrollController = useThreadScrollController();
  const [returnToLatestVisible, setReturnToLatestVisible] = useState(false);
  const [turnSpacerHeight, setTurnSpacerHeight] = useState(0);
  const [completedAnnouncement, setCompletedAnnouncement] = useState<{ key: string; text: string } | null>(null);
  const completedAnnouncementTrackerRef = useRef<CompletedItemAnnouncementTracker>({ hydrated: false, lastCompletedKey: null });
  const positionedConversationIdRef = useRef<string | null>(null);
  const latestSubmittedMessageIdRef = useRef<string | null>(null);
  const queuedSubmissions = useMemo(() => visibleQueuedSubmissions(props.state.queue), [props.state.queue]);
  const queuedClientIds = useMemo(() => new Set(queuedSubmissions.map((submission) => submission.clientUserMessageId).filter((value): value is string => Boolean(value))), [queuedSubmissions]);
  const projectedItems = useMemo(
    () => props.state.itemOrder.map((key) => props.state.items[key]).filter((entry): entry is NativeSessionItemBuffer => Boolean(entry) && isVisibleTranscriptItem(entry)),
    [props.state.itemOrder, props.state.items],
  );
  const items = useMemo(
    () =>
      latestReasoningItemsByTurn(
        projectedItems.filter((entry) => !entry.optimistic),
        props.state.activeTurnId,
      ),
    [projectedItems, props.state.activeTurnId],
  );
  const immediateOptimisticItems = useMemo(() => projectedItems.filter((entry) => entry.optimistic && entry.status !== 'queued' && !queuedClientIds.has(entry.clientUserMessageId ?? '')), [projectedItems, queuedClientIds]);
  const queuedOptimisticItems = useMemo(() => projectedItems.filter((entry) => entry.optimistic && entry.status === 'queued' && !queuedClientIds.has(entry.clientUserMessageId ?? '')), [projectedItems, queuedClientIds]);
  const lastUserKey = [...items].reverse().find((entry) => `${entry.type}`.toLocaleLowerCase().includes('user'))?.key;
  const lastAssistantKey = [...items].reverse().find((entry) => itemRole(entry) === 'assistant')?.key;
  const answeredRequests = useMemo(() => props.state.pendingRequests.filter(isAnsweredUserInputRequest), [props.state.pendingRequests]);
  const transcriptRows = useMemo(() => projectTranscriptRows(items, answeredRequests), [answeredRequests, items]);
  const lastItemKeyByTurn = useMemo(() => Object.fromEntries(items.map((item) => [item.turnId, item.key])), [items]);
  const orphanFailedTurns = useMemo(() => {
    const visibleTurnIds = new Set(items.map((item) => item.turnId));
    return Object.values(props.state.turnsByProviderId)
      .filter((turn) => turn.status === 'failed' && turn.error && !visibleTurnIds.has(turn.providerTurnId ?? ''))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }, [items, props.state.turnsByProviderId]);
  const showThinking = shouldShowTranscriptThinking(props.state);
  const historyHydrated = props.state.snapshot !== null;
  const historyUnavailable = !historyHydrated && (props.state.transportState === 'reconnecting' || props.state.transportState === 'failed');
  const latestSubmittedMessageId = [...immediateOptimisticItems, ...queuedOptimisticItems].at(-1)?.clientUserMessageId ?? null;

  useLayoutEffect(() => {
    const container = containerRef.current;
    const conversationId = props.state.conversationId;
    if (!container || !historyHydrated || !conversationId || positionedConversationIdRef.current === conversationId) return;
    positionedConversationIdRef.current = conversationId;
    container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
    setReturnToLatestVisible(false);
  }, [historyHydrated, props.state.conversationId, props.state.transcriptRevision]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !latestSubmittedMessageId || latestSubmittedMessageIdRef.current === latestSubmittedMessageId) return;
    latestSubmittedMessageIdRef.current = latestSubmittedMessageId;
    const effect = scrollController.onUserMessageSubmitted();
    if (effect.type !== 'scroll_to_bottom') return;
    container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
    setReturnToLatestVisible(false);
  }, [latestSubmittedMessageId, scrollController]);

  useEffect(() => {
    const resolution = resolveCompletedItemAnnouncement(completedAnnouncementTrackerRef.current, items, props.language);
    completedAnnouncementTrackerRef.current = resolution.tracker;
    if (resolution.announcement) setCompletedAnnouncement(resolution.announcement);
  }, [items, props.language, props.state.transcriptRevision]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (props.state.activeTurnId && previousTurnIdRef.current !== props.state.activeTurnId) {
      const effect = scrollController.onTurnStarted(metrics(container), Date.now());
      if (effect.type === 'position_new_turn') {
        pendingTurnPositionRef.current = true;
        setTurnSpacerHeight(effect.spacerHeight);
      }
    }
    if (!props.state.activeTurnId) {
      pendingTurnPositionRef.current = false;
      setTurnSpacerHeight(0);
    }
    previousTurnIdRef.current = props.state.activeTurnId;
  }, [props.state.activeTurnId, scrollController]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !pendingTurnPositionRef.current || turnSpacerHeight <= 0 || !props.state.activeTurnId) return;
    const cancel = scheduleTurnPositionAfterSpacerCommit(
      container,
      (callback) => window.requestAnimationFrame(callback),
      () => pendingTurnPositionRef.current && scrollController.getState().mode === 'prework_watch',
    );
    return () => cancel();
  }, [props.state.activeTurnId, scrollController, turnSpacerHeight]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const effect = scrollController.onDelta(metrics(container), Date.now());
    if (effect.type !== 'scroll_to_bottom') return;
    container.scrollTo({ top: container.scrollHeight, behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
  }, [props.state.transcriptRevision, scrollController]);

  return (
    <>
      <output className="session-sr-only session-transcript-announcement" aria-live="polite" aria-atomic="true">
        {completedAnnouncement ? <span key={completedAnnouncement.key}>{completedAnnouncement.text}</span> : null}
      </output>
      <div className="session-transcript-shell">
        <section
          ref={containerRef}
          className="session-transcript"
          role="log"
          aria-live="off"
          aria-label={props.language === 'zh-CN' ? '对话记录' : 'Conversation transcript'}
          onScroll={(event) => {
            const mode = scrollController.onUserScroll(metrics(event.currentTarget));
            setReturnToLatestVisible(mode.mode === 'static');
          }}
        >
          {transcriptRows.length > 0 ? (
            transcriptRows.map((row) => {
              if (row.kind === 'answered_request') {
                return <AnsweredRequestHistory key={row.key} request={row.request} language={props.language} />;
              }
              const rowItems = row.kind === 'item' ? [row.item] : row.items;
              const lastRowItem = rowItems[rowItems.length - 1]!;
              const turn = props.state.turnsByProviderId[lastRowItem.turnId];
              const changeSet = props.state.changeSetsByProviderId[lastRowItem.turnId];
              const closesVisibleTurn = lastItemKeyByTurn[lastRowItem.turnId] === lastRowItem.key;
              return (
                <Fragment key={row.key}>
                  {row.kind === 'item' ? (
                    row.item.type === 'plan' ? (
                      <PlanSummary item={row.item} language={props.language} panelOpen={props.openPlanItemId === (row.item.localItemId ?? row.item.itemId)} onOpenPanel={props.onOpenPlan} />
                    ) : normalizeItemType(row.item.type) === 'reasoning' ? (
                      <SessionReasoningSummary item={row.item} language={props.language} status={reasoningSummaryStatus(row.item, props.state)} />
                    ) : (
                      <ThreadItemView
                        item={row.item}
                        language={props.language}
                        isLatest={row.item.key === items[items.length - 1]?.key && !showThinking}
                        showAssistantActions={row.item.key === lastAssistantKey && !showThinking}
                        isLatestUser={row.item.key === lastUserKey}
                        onEdit={props.onEditUserItem}
                        onRetry={props.onRetryItem}
                        onOpenResource={props.onOpenResource}
                        onLoadResourcePreview={props.onLoadResourcePreview}
                      />
                    )
                  ) : (
                    <SessionActivityGroup items={row.items} language={props.language} />
                  )}
                  {closesVisibleTurn && changeSet && changeSet.state !== 'capturing' && (changeSet.fileCount > 0 || changeSet.state === 'conflicted') ? (
                    <TurnChangeCard changeSet={changeSet} language={props.language} onReview={props.onReviewTurnChanges} onOperate={props.onOperateTurnChangeSet} />
                  ) : null}
                  {closesVisibleTurn && turn?.status === 'failed' && turn.error ? <TurnFailureCard failure={turn.error} language={props.language} /> : null}
                  {closesVisibleTurn && turn ? <SessionTurnDuration turn={turn} requests={props.state.pendingRequests} language={props.language} /> : null}
                </Fragment>
              );
            })
          ) : !showThinking && immediateOptimisticItems.length === 0 && queuedOptimisticItems.length === 0 && queuedSubmissions.length === 0 && historyHydrated ? (
            <p className="session-transcript-empty">{props.language === 'zh-CN' ? '发送第一条消息后，真实 app-server 对话会显示在这里。' : 'Send the first message to begin the real app-server transcript.'}</p>
          ) : !showThinking && historyUnavailable ? (
            <p className="session-transcript-empty" role="status">
              {props.language === 'zh-CN' ? '历史消息暂不可用；连接恢复后会自动显示。' : 'History is temporarily unavailable and will reappear after the connection recovers.'}
            </p>
          ) : null}
          {orphanFailedTurns.map((turn) => (
            <TurnFailureCard key={`turn-failure:${turn.providerTurnId ?? turn.id}`} failure={turn.error!} language={props.language} />
          ))}
          {immediateOptimisticItems.map((item) => (
            <ThreadItemView key={item.key} item={item} language={props.language} isLatest />
          ))}
          {showThinking ? (
            <p className="session-transcript-thinking" role="status" aria-live="polite">
              <span className="session-thinking-pulse" aria-hidden="true" />
              {props.language === 'zh-CN' ? '正在思考' : 'Thinking'}
            </p>
          ) : null}
          {queuedOptimisticItems.map((item) => (
            <ThreadItemView key={item.key} item={item} language={props.language} />
          ))}
          {turnSpacerHeight > 0 && props.state.activeTurnId ? <span className="session-latest-turn-spacer" style={{ blockSize: `${turnSpacerHeight}px` }} aria-hidden="true" /> : null}
        </section>
        <button
          type="button"
          className="session-return-latest"
          data-visible={returnToLatestVisible || undefined}
          aria-hidden={!returnToLatestVisible}
          tabIndex={returnToLatestVisible ? 0 : -1}
          onClick={() => {
            const container = containerRef.current;
            if (!container) return;
            container.scrollTo({
              top: container.scrollHeight,
              behavior: prefersReducedMotion() ? 'instant' : 'smooth',
            });
            setReturnToLatestVisible(false);
          }}
        >
          {props.language === 'zh-CN' ? '返回最新消息' : 'Return to latest'}
        </button>
      </div>
    </>
  );
}

function TurnFailureCard(props: { failure: NativeTurnFailureSnapshot; language: SessionUiLanguage }) {
  const zh = props.language === 'zh-CN';
  const copy = failureCopy(props.failure.category, zh);
  return (
    <article className="session-turn-failure" role="alert" aria-label={zh ? '会话失败原因' : 'Conversation failure reason'}>
      <strong>{zh ? '本轮执行失败' : 'This turn failed'}</strong>
      <p>{copy.reason}</p>
      <small>{copy.recovery}</small>
      <details className="session-turn-failure-details">
        <summary>{zh ? '技术详情' : 'Technical details'}</summary>
        <dl>
          {props.failure.code ? (
            <>
              <dt>{zh ? '错误代码' : 'Error code'}</dt>
              <dd>{props.failure.code}</dd>
            </>
          ) : null}
          {props.failure.providerStatus ? (
            <>
              <dt>{zh ? '运行状态' : 'Provider status'}</dt>
              <dd>{props.failure.providerStatus}</dd>
            </>
          ) : null}
          <dt>{zh ? '原始原因（已脱敏）' : 'Original reason (redacted)'}</dt>
          <dd>{props.failure.message}</dd>
          {props.failure.additionalDetails.map((detail) => (
            <Fragment key={detail}>
              <dt>{zh ? '补充信息' : 'Additional detail'}</dt>
              <dd>{detail}</dd>
            </Fragment>
          ))}
        </dl>
      </details>
    </article>
  );
}

function failureCopy(category: NativeTurnFailureSnapshot['category'], zh: boolean): { reason: string; recovery: string } {
  if (category === 'authentication')
    return zh
      ? { reason: '登录状态或 API Key 未通过认证，模型服务拒绝了本轮请求。', recovery: '请完成对应运行内核的登录，或检查模型连接中的 API Key，然后重新发送。' }
      : { reason: 'The model service rejected this turn because the login or API key was not accepted.', recovery: 'Sign in to the selected runtime or check the model connection API key, then send again.' };
  if (category === 'rate_limit')
    return zh
      ? { reason: '模型服务触发了限流或配额限制。', recovery: '请稍后重试，或检查账号配额和并发限制。' }
      : { reason: 'The model service rate limit or quota was reached.', recovery: 'Try again later, or check the account quota and concurrency limits.' };
  if (category === 'network')
    return zh
      ? { reason: 'Zeus 与模型服务之间的网络连接中断或超时。', recovery: '请检查网络和服务地址，连接恢复后重新发送。' }
      : { reason: 'The connection between Zeus and the model service failed or timed out.', recovery: 'Check the network and service URL, then send again after connectivity recovers.' };
  if (category === 'configuration')
    return zh
      ? { reason: '当前模型或请求参数不被接入渠道接受。', recovery: '请检查所选模型、思考深度和接入渠道后重新发送。' }
      : { reason: 'The selected channel rejected the model or request parameters.', recovery: 'Check the model, reasoning effort, and access channel, then send again.' };
  if (category === 'permission')
    return zh
      ? { reason: '本轮操作被权限或安全边界阻止。', recovery: '请检查项目授权和权限模式，再决定是否重新发送。' }
      : { reason: 'A permission or safety boundary blocked this turn.', recovery: 'Review the project authorization and permission mode before sending again.' };
  return zh
    ? { reason: '智能体运行内核报告本轮失败。', recovery: '请展开技术详情查看真实原因，修复后重新发送。' }
    : { reason: 'The agent runtime reported that this turn failed.', recovery: 'Open the technical details for the reported cause, fix it, and send again.' };
}

export type TranscriptRow =
  | { kind: 'item'; key: string; item: NativeSessionItemBuffer }
  | { kind: 'answered_request'; key: string; request: NativePendingRequest }
  | {
      kind: 'activity';
      key: string;
      items: NativeSessionItemBuffer[];
    };

export function projectTranscriptRows(items: readonly NativeSessionItemBuffer[], answeredRequests: readonly NativePendingRequest[] = []): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let activity: NativeSessionItemBuffer[] = [];
  const flushActivity = () => {
    if (activity.length === 0) return;
    rows.push({
      kind: 'activity',
      key: `activity:${activity[0]!.key}`,
      items: activity,
    });
    activity = [];
  };
  const timeline: Array<{ kind: 'item'; item: NativeSessionItemBuffer } | { kind: 'answered_request'; request: NativePendingRequest }> = items.map((item) => ({ kind: 'item', item }));
  for (const request of [...answeredRequests].sort((left, right) => (left.resolvedAt ?? left.createdAt).localeCompare(right.resolvedAt ?? right.createdAt))) {
    const resolvedAt = request.resolvedAt ?? request.createdAt;
    const insertionIndex = timeline.findIndex((entry) => entry.kind === 'item' && (entry.item.updatedAt ?? '') >= resolvedAt);
    timeline.splice(insertionIndex < 0 ? timeline.length : insertionIndex, 0, { kind: 'answered_request', request });
  }
  for (const entry of timeline) {
    if (entry.kind === 'answered_request') {
      flushActivity();
      rows.push({ kind: 'answered_request', key: `answered-request:${entry.request.id}`, request: entry.request });
      continue;
    }
    const item = entry.item;
    if (!isOperationalActivityItem(item)) {
      flushActivity();
      rows.push({ kind: 'item', key: item.key, item });
      continue;
    }
    if (activity.length > 0 && activity[activity.length - 1]!.turnId !== item.turnId) flushActivity();
    activity.push(item);
  }
  flushActivity();
  return rows;
}

export function isVisibleTranscriptItem(item: NativeSessionItemBuffer): boolean {
  if (itemRole(item) !== 'commentary') return true;
  return transcriptItemText(item).trim().length > 0;
}

export function shouldShowTranscriptThinking(state: NativeSessionState): boolean {
  if (state.conversationState !== 'starting_turn' && state.conversationState !== 'active_prework' && state.conversationState !== 'active_final_answer') return false;
  if (!state.activeTurnId) return true;
  return state.visibleFeedbackEpoch < state.feedbackEpoch;
}

export interface CompletedItemAnnouncementTracker {
  hydrated: boolean;
  lastCompletedKey: string | null;
}

export function resolveCompletedItemAnnouncement(
  tracker: CompletedItemAnnouncementTracker,
  items: readonly Pick<NativeSessionItemBuffer, 'key' | 'status' | 'optimistic' | 'text'>[],
  language: SessionUiLanguage,
): { tracker: CompletedItemAnnouncementTracker; announcement: { key: string; text: string } | null } {
  const completed = [...items].reverse().find((entry) => entry.status === 'completed' && !entry.optimistic);
  if (!tracker.hydrated) {
    return { tracker: { hydrated: true, lastCompletedKey: completed?.key ?? null }, announcement: null };
  }
  if (!completed || completed.key === tracker.lastCompletedKey) return { tracker, announcement: null };
  const label = language === 'zh-CN' ? '新内容已完成' : 'New content completed';
  return {
    tracker: { hydrated: true, lastCompletedKey: completed.key },
    announcement: { key: completed.key, text: `${label}: ${completed.text.slice(0, 180)}` },
  };
}

export function scheduleTurnPositionAfterSpacerCommit(container: Pick<HTMLElement, 'scrollHeight' | 'scrollTo'>, requestFrame: (callback: FrameRequestCallback) => number, shouldPosition: () => boolean): () => void {
  const frameId = requestFrame(() => {
    // 回调在 spacer commit/layout 后才读取 scrollHeight，不能使用 setState 前的旧高度。
    if (shouldPosition()) container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
  });
  return () => {
    if (typeof window !== 'undefined') window.cancelAnimationFrame(frameId);
  };
}

function metrics(element: HTMLElement) {
  return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
}

function normalizeItemType(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_\-/]+/gu, '');
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
