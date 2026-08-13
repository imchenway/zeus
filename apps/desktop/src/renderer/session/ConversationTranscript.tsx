import { Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isOperationalActivityItem, SessionActivityGroup, SessionTurnDuration } from './SessionActivity.js';
import { itemRole, type SessionUiLanguage, ThreadItemView, transcriptItemText } from './ThreadItemView.js';
import { PlanSummary } from './PlanSummary.js';
import type {
  ConversationResource,
  ConversationResourcePreview,
  NativePendingRequest,
  NativeSessionError,
  NativeSessionItemBuffer,
  NativeSessionState,
  NativeTurnFailureSnapshot,
  TurnChangeSet,
  TurnChangeSetOperationResult,
} from './sessionTypes.js';
import type { ConversationFileLocation, ConversationOpenTarget } from '@zeus/shared';
import { useThreadScrollController } from './useThreadScrollController.js';
import { TurnChangeCard } from './TurnChanges.js';
import { visibleQueuedSubmissions } from './QueuedConversationMessages.js';
import { latestReasoningItemsByTurn, reasoningSummaryStatus, SessionReasoningSummary } from './SessionReasoningSummary.js';
import { AnsweredRequestHistory, isAnsweredUserInputRequest } from './AnsweredRequestHistory.js';
import { useNewItemMotionIds } from '../ui/useNewItemMotion.js';

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
  onLatestContentVisibilityChange?: (visible: boolean) => void;
  creationStatus?: SessionCreationStatus;
}

export interface SessionCreationStatus {
  state: 'creating' | 'failed';
  message: string;
  error?: string | null;
  retryLabel?: string;
  onRetry?: () => void | Promise<void>;
}

const sessionConnectionSymbol = (
  <span className="session-connection-symbol" aria-hidden="true">
    <svg viewBox="0 0 24 24">
      <path d="M4.5 9.6a11.5 11.5 0 0 1 15 0M7.8 13a6.7 6.7 0 0 1 8.4 0M11.1 16.4a1.45 1.45 0 0 1 1.8 0" />
    </svg>
  </span>
);

export function ConversationTranscript(props: ConversationTranscriptProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const latestContentMarkerRef = useRef<HTMLSpanElement | null>(null);
  const previousTurnIdRef = useRef<string | null>(null);
  const activeTurnTrackingInitializedRef = useRef(false);
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
  const collapsedErrorItems = useMemo(() => collapseRepeatedErrorItems(projectedItems), [projectedItems]);
  const providerErrorItemsByTurn = useMemo(() => groupErrorItemsByTurn(collapsedErrorItems), [collapsedErrorItems]);
  const transcriptItems = useMemo(
    () =>
      collapsedErrorItems.filter((item) => {
        const turn = props.state.turnsByProviderId[item.turnId];
        // 轮次失败卡片已经承载底层原因时，不再把同一诊断事件单独画成第二张红卡。
        return !(itemRole(item) === 'error' && turn?.status === 'failed' && turn.error);
      }),
    [collapsedErrorItems, props.state.turnsByProviderId],
  );
  const items = useMemo(
    () =>
      latestReasoningItemsByTurn(
        transcriptItems.filter((entry) => !entry.optimistic),
        props.state.activeTurnId,
      ),
    [props.state.activeTurnId, transcriptItems],
  );
  const immediateOptimisticItems = useMemo(() => transcriptItems.filter((entry) => entry.optimistic && entry.status !== 'queued' && !queuedClientIds.has(entry.clientUserMessageId ?? '')), [queuedClientIds, transcriptItems]);
  const queuedOptimisticItems = useMemo(() => transcriptItems.filter((entry) => entry.optimistic && entry.status === 'queued' && !queuedClientIds.has(entry.clientUserMessageId ?? '')), [queuedClientIds, transcriptItems]);
  const enteringItemIds = useNewItemMotionIds([...items, ...immediateOptimisticItems, ...queuedOptimisticItems].map((item) => item.key));
  const lastUserKey = [...items].reverse().find((entry) => `${entry.type}`.toLocaleLowerCase().includes('user'))?.key;
  const answeredRequests = useMemo(() => props.state.pendingRequests.filter(isAnsweredUserInputRequest), [props.state.pendingRequests]);
  const transcriptRows = useMemo(() => projectTranscriptRows(items, answeredRequests), [answeredRequests, items]);
  const turnRows = useMemo(() => projectTranscriptTurnRows(transcriptRows, props.state.activeTurnId), [props.state.activeTurnId, transcriptRows]);
  const turnWorkIds = useMemo(() => new Set(turnRows.filter((row): row is TranscriptTurnWorkRow => row.kind === 'turn_work').map((row) => row.turnId)), [turnRows]);
  const renderedTurnIds = useMemo(
    () =>
      new Set(turnRows.flatMap((row) => (row.kind === 'answered_request' ? [] : [row.kind === 'turn_work' ? row.turnId : row.kind === 'item' ? row.item.turnId : row.items[0]?.turnId]).filter((turnId): turnId is string => Boolean(turnId)))),
    [turnRows],
  );
  const activeTurnHasRenderedRow = Boolean(props.state.activeTurnId && renderedTurnIds.has(props.state.activeTurnId));
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
  const maintainLatestPosition = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const effect = scrollController.onDelta(metrics(container), Date.now());
    if (effect.type !== 'scroll_to_bottom') return;
    scrollToLatest(container);
    setReturnToLatestVisible(false);
  }, [scrollController]);

  const reportLatestContentVisibility = useCallback(
    (container: HTMLElement) => {
      const current = metrics(container);
      const marker = latestContentMarkerRef.current;
      const markerRect = marker?.getBoundingClientRect();
      const topElement = markerRect ? document.elementFromPoint(markerRect.left + Math.max(0.5, markerRect.width / 2), markerRect.top + Math.max(0.25, markerRect.height / 2)) : null;
      const markerVisible = Boolean(markerRect && markerRect.bottom >= 0 && markerRect.top <= window.innerHeight && topElement && (topElement === marker || marker?.contains(topElement) || container.contains(topElement)));
      props.onLatestContentVisibilityChange?.(current.scrollHeight - current.scrollTop - current.clientHeight <= 24 && markerVisible);
    },
    [props.onLatestContentVisibilityChange],
  );

  useEffect(
    () => () => {
      props.onLatestContentVisibilityChange?.(false);
    },
    [props.onLatestContentVisibilityChange],
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    const conversationId = props.state.conversationId;
    if (!container || !historyHydrated || !conversationId || positionedConversationIdRef.current === conversationId) return;
    positionedConversationIdRef.current = conversationId;
    scrollToLatest(container);
    setReturnToLatestVisible(false);
  }, [historyHydrated, props.state.conversationId, props.state.transcriptRevision]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !latestSubmittedMessageId || latestSubmittedMessageIdRef.current === latestSubmittedMessageId) return;
    latestSubmittedMessageIdRef.current = latestSubmittedMessageId;
    const effect = scrollController.onExplicitLatestRequest();
    if (effect.type !== 'scroll_to_bottom') return;
    scrollToLatest(container);
    setReturnToLatestVisible(false);
  }, [latestSubmittedMessageId, scrollController]);

  useEffect(() => {
    const resolution = resolveCompletedItemAnnouncement(completedAnnouncementTrackerRef.current, items, props.language);
    completedAnnouncementTrackerRef.current = resolution.tracker;
    if (resolution.announcement) setCompletedAnnouncement(resolution.announcement);
  }, [items, props.language, props.state.transcriptRevision]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !historyHydrated) return;
    if (!activeTurnTrackingInitializedRef.current) {
      // 首次水合得到的活动轮次属于既有会话现场，不能误当成当前页面刚开始的新轮次。
      activeTurnTrackingInitializedRef.current = true;
      previousTurnIdRef.current = props.state.activeTurnId;
      pendingTurnPositionRef.current = false;
      setTurnSpacerHeight(0);
      return;
    }
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
  }, [historyHydrated, props.state.activeTurnId, scrollController]);

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

  useLayoutEffect(() => {
    maintainLatestPosition();
    const container = containerRef.current;
    if (container) reportLatestContentVisibility(container);
  }, [maintainLatestPosition, props.creationStatus?.error, props.creationStatus?.state, props.state.transcriptRevision, reportLatestContentVisibility]);

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
            reportLatestContentVisibility(event.currentTarget);
          }}
        >
          {turnRows.length > 0 ? (
            turnRows.map((row) => {
              if (row.kind === 'answered_request') {
                return <AnsweredRequestHistory key={row.key} request={row.request} language={props.language} />;
              }
              if (row.kind === 'turn_work') {
                const turn = props.state.turnsByProviderId[row.turnId];
                if (!turn) {
                  return (
                    <Fragment key={row.key}>
                      {row.rows.map((child) => (
                        <Fragment key={child.key}>{renderTranscriptRow(child, transcriptRowRenderOptions(props, items, showThinking, lastUserKey, true, enteringItemIds, maintainLatestPosition))}</Fragment>
                      ))}
                    </Fragment>
                  );
                }
                const containsLastItem = row.rows.some((child) => transcriptRowContainsItemKey(child, lastItemKeyByTurn[row.turnId]));
                const renderMarkers = !turnRows.some((candidate) => candidate.kind === 'item' && isFinalAnswerItem(candidate.item) && candidate.item.turnId === row.turnId) && containsLastItem;
                return (
                  <Fragment key={row.key}>
                    <SessionTurnDuration turn={turn} requests={props.state.pendingRequests} language={props.language}>
                      {row.rows.map((child) => (
                        <Fragment key={child.key}>
                          {renderTranscriptRow(child, transcriptRowRenderOptions(props, items, showThinking && props.state.activeTurnId === row.turnId, lastUserKey, true, enteringItemIds, maintainLatestPosition))}
                        </Fragment>
                      ))}
                      {showThinking && props.state.activeTurnId === row.turnId ? <TranscriptThinking language={props.language} /> : null}
                    </SessionTurnDuration>
                    {renderMarkers ? renderTurnArtifacts(row.turnId, props, lastItemKeyByTurn[row.turnId], providerErrorItemsByTurn.get(row.turnId)) : null}
                  </Fragment>
                );
              }
              const rowItems = row.kind === 'item' ? [row.item] : row.items;
              const lastRowItem = rowItems[rowItems.length - 1]!;
              const turn = props.state.turnsByProviderId[lastRowItem.turnId];
              const closesVisibleTurn = lastItemKeyByTurn[lastRowItem.turnId] === lastRowItem.key;
              const finalAnswer = row.kind === 'item' && isFinalAnswerItem(row.item);
              return (
                <Fragment key={row.key}>
                  {finalAnswer && turn && !turnWorkIds.has(lastRowItem.turnId) ? (
                    <SessionTurnDuration turn={turn} requests={props.state.pendingRequests} language={props.language}>
                      {showThinking && props.state.activeTurnId === lastRowItem.turnId ? <TranscriptThinking language={props.language} /> : null}
                    </SessionTurnDuration>
                  ) : null}
                  {renderTranscriptRow(row, transcriptRowRenderOptions(props, items, showThinking, lastUserKey, false, enteringItemIds, maintainLatestPosition))}
                  {closesVisibleTurn ? renderTurnArtifacts(lastRowItem.turnId, props, lastRowItem.key, providerErrorItemsByTurn.get(lastRowItem.turnId)) : null}
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
            <TurnFailureCard key={`turn-failure:${turn.providerTurnId ?? turn.id}`} failure={turn.error!} language={props.language} providerErrors={providerErrorItemsByTurn.get(turn.providerTurnId ?? '')} />
          ))}
          {immediateOptimisticItems.map((item) => (
            <Fragment key={item.key}>
              <ThreadItemView item={item} language={props.language} isLatest animateEntrance={enteringItemIds.has(item.key)} onVisibleContentChange={maintainLatestPosition} />
              {!showThinking || item.status === 'failed' || item.status === 'unconfirmed' || item.status === 'paused' ? (
                <PendingMessageDeliveryFeedback item={item} stateError={props.state.error} language={props.language} onReturnToComposer={props.onRetryItem ? () => props.onRetryItem?.(item) : undefined} />
              ) : null}
            </Fragment>
          ))}
          {props.creationStatus ? <SessionCreationNotice status={props.creationStatus} language={props.language} /> : null}
          {showThinking && props.state.activeTurnId && props.state.turnsByProviderId[props.state.activeTurnId] && !activeTurnHasRenderedRow ? (
            <SessionTurnDuration turn={props.state.turnsByProviderId[props.state.activeTurnId]} requests={props.state.pendingRequests} language={props.language}>
              <TranscriptThinking language={props.language} />
            </SessionTurnDuration>
          ) : showThinking && !activeTurnHasRenderedRow ? (
            <TranscriptThinking language={props.language} />
          ) : null}
          {queuedOptimisticItems.map((item) => (
            <ThreadItemView key={item.key} item={item} language={props.language} animateEntrance={enteringItemIds.has(item.key)} onVisibleContentChange={maintainLatestPosition} />
          ))}
          {turnSpacerHeight > 0 && props.state.activeTurnId ? <span className="session-latest-turn-spacer" style={{ blockSize: `${turnSpacerHeight}px` }} aria-hidden="true" /> : null}
          <span ref={latestContentMarkerRef} className="session-latest-content-marker" aria-hidden="true" />
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
            const effect = scrollController.onExplicitLatestRequest();
            if (effect.type !== 'scroll_to_bottom') return;
            scrollToLatest(container);
            setReturnToLatestVisible(false);
          }}
        >
          {props.language === 'zh-CN' ? '返回最新消息' : 'Return to latest'}
        </button>
      </div>
    </>
  );
}

function SessionCreationNotice(props: { status: SessionCreationStatus; language: SessionUiLanguage }) {
  return (
    <section className={`session-creation-status is-${props.status.state}`} role={props.status.state === 'failed' ? 'alert' : 'status'} aria-live="polite">
      {props.status.state === 'creating' ? (
        sessionConnectionSymbol
      ) : (
        <span className="session-creation-failure-symbol" aria-hidden="true">
          !
        </span>
      )}
      <span className="session-creation-status-copy">
        <strong>{props.status.message}</strong>
        {props.status.error ? <small>{props.status.error}</small> : null}
      </span>
      {props.status.state === 'failed' && props.status.onRetry ? (
        <button type="button" onClick={() => void props.status.onRetry?.()}>
          {props.status.retryLabel ?? (props.language === 'zh-CN' ? '重试' : 'Retry')}
        </button>
      ) : null}
    </section>
  );
}

function TurnFailureCard(props: { failure: NativeTurnFailureSnapshot; language: SessionUiLanguage; providerErrors?: readonly NativeSessionItemBuffer[] }) {
  const zh = props.language === 'zh-CN';
  const copy = failureCopy(props.failure.category, zh);
  const providerDetails = (props.providerErrors ?? []).map(providerErrorDetails);
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
          {providerDetails.map((detail) => (
            <Fragment key={`${detail.code ?? ''}:${detail.message}:${detail.method ?? ''}`}>
              {detail.code ? (
                <>
                  <dt>{zh ? '底层错误代码' : 'Provider error code'}</dt>
                  <dd>{detail.code}</dd>
                </>
              ) : null}
              <dt>{zh ? '底层错误' : 'Provider error'}</dt>
              <dd>{detail.message}</dd>
              {detail.method ? (
                <>
                  <dt>{zh ? '触发事件' : 'Provider event'}</dt>
                  <dd>{detail.method}</dd>
                </>
              ) : null}
            </Fragment>
          ))}
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

function collapseRepeatedErrorItems(items: readonly NativeSessionItemBuffer[]): NativeSessionItemBuffer[] {
  const seen = new Set<string>();
  const result: NativeSessionItemBuffer[] = [];
  for (const item of items) {
    if (itemRole(item) !== 'error') {
      result.push(item);
      continue;
    }
    // Provider 事件异常仍保留首条原始诊断；后续相同错误只在展示层合并，避免一轮出现多张相同红卡。
    const key = `${item.turnId}\u0000${providerErrorFingerprint(item)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function groupErrorItemsByTurn(items: readonly NativeSessionItemBuffer[]): Map<string, NativeSessionItemBuffer[]> {
  const grouped = new Map<string, NativeSessionItemBuffer[]>();
  for (const item of items) {
    if (itemRole(item) !== 'error') continue;
    const turnItems = grouped.get(item.turnId) ?? [];
    turnItems.push(item);
    grouped.set(item.turnId, turnItems);
  }
  return grouped;
}

function providerErrorFingerprint(item: NativeSessionItemBuffer): string {
  const detail = providerErrorDetails(item);
  const fingerprint = `${detail.code ?? ''}\u001f${detail.message}`;
  return fingerprint === '\u001f' ? (item.providerItemId ?? item.key) : fingerprint;
}

function providerErrorDetails(item: NativeSessionItemBuffer): { code: string | null; message: string; method: string | null } {
  const nestedError = recordValue(item.payload.error);
  const code = primitiveValue(nestedError?.code ?? item.payload.code);
  const message = primitiveValue(nestedError?.message ?? item.payload.message ?? item.text) ?? '';
  return {
    code,
    message,
    method: primitiveValue(item.payload.method),
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function primitiveValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

export interface TranscriptTurnWorkRow {
  kind: 'turn_work';
  key: string;
  turnId: string;
  rows: TranscriptRow[];
}

export type TranscriptTurnRow = TranscriptRow | TranscriptTurnWorkRow;

interface TranscriptRowRenderOptions {
  props: ConversationTranscriptProps;
  items: readonly NativeSessionItemBuffer[];
  showThinking: boolean;
  lastUserKey: string | undefined;
  insideWork: boolean;
  enteringItemIds: ReadonlySet<string>;
  onVisibleContentChange: () => void;
}

function transcriptRowRenderOptions(
  props: ConversationTranscriptProps,
  items: readonly NativeSessionItemBuffer[],
  showThinking: boolean,
  lastUserKey: string | undefined,
  insideWork: boolean,
  enteringItemIds: ReadonlySet<string>,
  onVisibleContentChange: () => void,
): TranscriptRowRenderOptions {
  return { props, items, showThinking, lastUserKey, insideWork, enteringItemIds, onVisibleContentChange };
}

function renderTranscriptRow(row: TranscriptRow, options: TranscriptRowRenderOptions): ReactNode {
  if (row.kind === 'answered_request') return <AnsweredRequestHistory request={row.request} language={options.props.language} />;
  if (row.kind === 'activity') return <SessionActivityGroup items={row.items} language={options.props.language} />;
  if (row.item.type === 'plan') {
    return <PlanSummary item={row.item} language={options.props.language} panelOpen={options.props.openPlanItemId === (row.item.localItemId ?? row.item.itemId)} onOpenPanel={options.props.onOpenPlan} />;
  }
  if (normalizeItemType(row.item.type) === 'reasoning') {
    return <SessionReasoningSummary item={row.item} language={options.props.language} status={reasoningSummaryStatus(row.item, options.props.state)} />;
  }
  return (
    <ThreadItemView
      item={row.item}
      language={options.props.language}
      isLatest={!options.insideWork && row.item.key === options.items[options.items.length - 1]?.key && !options.showThinking}
      animateEntrance={options.enteringItemIds.has(row.item.key)}
      showAssistantActions={!options.insideWork && itemRole(row.item) === 'assistant' && !options.showThinking}
      isLatestUser={row.item.key === options.lastUserKey}
      onEdit={options.props.onEditUserItem}
      onRetry={options.props.onRetryItem}
      onOpenResource={options.props.onOpenResource}
      onLoadResourcePreview={options.props.onLoadResourcePreview}
      onVisibleContentChange={options.onVisibleContentChange}
    />
  );
}

function TranscriptThinking(props: { language: SessionUiLanguage }): ReactNode {
  return (
    <p className="session-transcript-thinking" role="status" aria-live="polite">
      <span className="session-thinking-pulse" aria-hidden="true" />
      {props.language === 'zh-CN' ? '正在思考' : 'Thinking'}
    </p>
  );
}

function PendingMessageDeliveryFeedback(props: { item: NativeSessionItemBuffer; stateError: NativeSessionError | null; language: SessionUiLanguage; onReturnToComposer?: () => void }): ReactNode {
  const zh = props.language === 'zh-CN';
  const deliveryError = nativeSessionErrorFrom(props.item.payload.deliveryError) ?? (props.stateError?.code === 'ZEUS_NATIVE_ACCEPTANCE_HYDRATION_PENDING' ? props.stateError : null);
  const unconfirmed = props.item.status === 'unconfirmed' || props.item.status === 'paused';
  const failed = props.item.status === 'failed';
  const delivery = typeof props.item.payload.delivery === 'string' ? props.item.payload.delivery : 'queue';
  const reason = deliveryError ? messageDeliveryFailureReason(deliveryError, zh) : null;
  const title = failed
    ? zh
      ? '消息发送失败'
      : 'Message send failed'
    : unconfirmed
      ? zh
        ? '发送结果待确认'
        : 'Send outcome unconfirmed'
      : deliveryError?.code === 'ZEUS_NATIVE_ACCEPTANCE_HYDRATION_PENDING'
        ? zh
          ? '消息已接收，正在确认记录'
          : 'Message accepted; confirming its record'
        : delivery === 'steer_now'
          ? zh
            ? '正在把消息交给当前回复'
            : 'Sending the message to the current response'
          : props.item.status === 'pending'
            ? zh
              ? '正在发送消息'
              : 'Sending message'
            : zh
              ? '消息已接收，正在启动处理'
              : 'Message accepted; starting processing';
  const guidance = failed
    ? zh
      ? '内容已保留在输入框中，可修改后重新发送。'
      : 'The content remains in the composer so you can edit and send it again.'
    : unconfirmed
      ? zh
        ? 'Zeus 不会自动重发，避免模型收到重复消息。'
        : 'Zeus will not resend automatically, preventing duplicate model input.'
      : null;

  return (
    <section
      className="session-message-delivery-feedback"
      data-state={failed ? 'failed' : unconfirmed ? 'unconfirmed' : 'pending'}
      role={failed || unconfirmed ? 'alert' : 'status'}
      aria-live={failed || unconfirmed ? 'assertive' : 'polite'}
    >
      <span className="session-thinking-pulse" aria-hidden="true" />
      <span>
        <strong>{title}</strong>
        {reason ? <small>{reason}</small> : null}
        {guidance ? <small>{guidance}</small> : null}
        {failed && props.onReturnToComposer ? (
          <button type="button" onClick={props.onReturnToComposer}>
            {zh ? '回到输入框' : 'Return to composer'}
          </button>
        ) : null}
        {deliveryError && reason !== deliveryError.message ? (
          <details>
            <summary>{zh ? '技术详情' : 'Technical details'}</summary>
            <code>{[deliveryError.code, deliveryError.message].filter(Boolean).join(': ')}</code>
          </details>
        ) : null}
      </span>
    </section>
  );
}

function nativeSessionErrorFrom(value: unknown): NativeSessionError | null {
  if (!value || typeof value !== 'object') return null;
  const error = value as Partial<NativeSessionError>;
  if (typeof error.message !== 'string') return null;
  return {
    message: error.message,
    code: typeof error.code === 'string' ? error.code : null,
    recoveryRequired: error.recoveryRequired === true,
    retryable: error.retryable !== false,
    ...(typeof error.status === 'number' ? { status: error.status } : {}),
  };
}

function messageDeliveryFailureReason(error: NativeSessionError, zh: boolean): string {
  switch (error.code) {
    case 'ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE':
      return zh ? '当前会话的执行目录不可用，Zeus 没有把消息交给模型。' : 'The execution directory is unavailable, so Zeus did not send the message to the model.';
    case 'ZEUS_TASK_REOPEN_REQUIRED':
      return zh ? '任务已经完成或取消，需要先重新打开任务才能继续。' : 'The task is completed or cancelled and must be reopened before continuing.';
    case 'ZEUS_NATIVE_ACCEPTANCE_HYDRATION_PENDING':
      return zh ? 'Zeus 已接收消息，但暂时无法读取它的持久记录。' : 'Zeus accepted the message but cannot read its durable record yet.';
    case 'ZEUS_CODEX_LOGIN_REQUIRED':
      return zh ? 'Zeus 的 Codex 登录尚未就绪，消息没有进入模型处理。' : 'The Zeus Codex login is not ready, so the model did not receive the message.';
    case 'ZEUS_TASK_INTEGRATION_AI_BUSY':
      return zh ? '冲突处理现场正在收尾，暂时不能开始下一轮。' : 'The conflict workspace is being finalized and cannot start another turn yet.';
    default:
      if (error.status === 429) return zh ? '当前请求过多，Zeus 暂时无法开始处理。' : 'Too many requests are active, so Zeus cannot start processing yet.';
      return error.message;
  }
}

function renderTurnArtifacts(turnId: string, props: ConversationTranscriptProps, lastItemKey: string | undefined, providerErrors?: readonly NativeSessionItemBuffer[]): ReactNode {
  if (!lastItemKey) return null;
  const turn = props.state.turnsByProviderId[turnId];
  if (!turn) return null;
  const changeSet = props.state.changeSetsByProviderId[turnId];
  return (
    <>
      {changeSet && changeSet.state !== 'capturing' && (changeSet.fileCount > 0 || changeSet.state === 'conflicted') ? (
        <TurnChangeCard changeSet={changeSet} language={props.language} onReview={props.onReviewTurnChanges} onOperate={props.onOperateTurnChangeSet} />
      ) : null}
      {turn.status === 'failed' && turn.error ? <TurnFailureCard failure={turn.error} language={props.language} providerErrors={providerErrors} /> : null}
    </>
  );
}

export function projectTranscriptTurnRows(rows: readonly TranscriptRow[], activeTurnId: string | null = null): TranscriptTurnRow[] {
  const finalAnswerTurnIds = new Set(rows.flatMap((row) => (row.kind === 'item' && isFinalAnswerItem(row.item) ? [row.item.turnId] : [])));
  const activeTurnOpeningUserRowKey = activeTurnId ? rows.find((row) => row.kind === 'item' && row.item.turnId === activeTurnId && itemRole(row.item) === 'user')?.key : undefined;
  const liveTurnRows = activeTurnId && !finalAnswerTurnIds.has(activeTurnId) ? rows.filter((row) => row.key !== activeTurnOpeningUserRowKey && transcriptRowTurnId(row) === activeTurnId && isLiveTurnTimelineRow(row)) : [];
  const liveTurnRowKeys = new Set(liveTurnRows.map((row) => row.key));
  const firstLiveTurnRowKey = liveTurnRows[0]?.key;
  const workRowsByFinalTurn = new Map<string, TranscriptRow[]>();
  const firstWorkRowKeyByFinalTurn = new Map<string, string>();
  const finalWorkRowKeys = new Set<string>();
  for (const row of rows) {
    const turnId = transcriptRowTurnId(row);
    if (!turnId || !finalAnswerTurnIds.has(turnId) || !isTurnProcessRow(row)) continue;
    const workRows = workRowsByFinalTurn.get(turnId) ?? [];
    workRows.push(row);
    workRowsByFinalTurn.set(turnId, workRows);
    firstWorkRowKeyByFinalTurn.set(turnId, firstWorkRowKeyByFinalTurn.get(turnId) ?? row.key);
    finalWorkRowKeys.add(row.key);
  }

  const projected: TranscriptTurnRow[] = [];
  const emittedFinalWorkTurns = new Set<string>();
  for (const row of rows) {
    if (activeTurnId && firstLiveTurnRowKey === row.key) {
      projected.push({ kind: 'turn_work', key: `turn-work-live:${activeTurnId}`, turnId: activeTurnId, rows: liveTurnRows });
    }
    if (liveTurnRowKeys.has(row.key)) continue;
    const turnId = transcriptRowTurnId(row);
    const finalWorkRows = turnId ? workRowsByFinalTurn.get(turnId) : undefined;
    if (turnId && finalWorkRows && firstWorkRowKeyByFinalTurn.get(turnId) === row.key && !emittedFinalWorkTurns.has(turnId)) {
      projected.push({ kind: 'turn_work', key: `turn-work-final:${turnId}`, turnId, rows: finalWorkRows });
      emittedFinalWorkTurns.add(turnId);
    }
    if (finalWorkRowKeys.has(row.key)) continue;
    projected.push(row);
  }
  return projected;
}

function isLiveTurnTimelineRow(row: TranscriptRow): boolean {
  if (row.kind === 'answered_request' || row.kind === 'activity') return true;
  // 计划是需要独立审核的产物，不属于仍在展开的过程正文。
  return row.item.type !== 'plan' && !isFinalAnswerItem(row.item);
}

function isTurnProcessRow(row: TranscriptRow): boolean {
  if (row.kind === 'answered_request') return false;
  if (row.kind === 'activity') return true;
  // 计划是交给用户审核的最终产物，必须独立展示，不能折叠进“已处理”过程。
  if (row.item.type === 'plan') return false;
  return itemRole(row.item) !== 'user' && !isFinalAnswerItem(row.item);
}

function transcriptRowTurnId(row: TranscriptRow): string | null {
  if (row.kind === 'answered_request') return row.request.turnId;
  return row.kind === 'item' ? row.item.turnId : (row.items[0]?.turnId ?? null);
}

function transcriptRowContainsItemKey(row: TranscriptRow, itemKey: string | undefined): boolean {
  if (!itemKey || row.kind === 'answered_request') return false;
  return row.kind === 'item' ? row.item.key === itemKey : row.items.some((item) => item.key === itemKey);
}

export function isFinalAnswerItem(item: NativeSessionItemBuffer): boolean {
  const providerPhase = typeof item.payload.phase === 'string' ? item.payload.phase : item.phase;
  return itemRole(item) === 'assistant' && (providerPhase === 'final_answer' || providerPhase === 'finalAnswer');
}

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
    const requestTimelineAt = request.resolvedAt ?? request.createdAt;
    // 已回答询问按答案提交时间落位；普通条目使用首次进入时间线的稳定时间，不能用流式更新后的时间重排。
    const insertionIndex = timeline.findIndex((entry) => entry.kind === 'item' && (entry.item.timelineAt ?? entry.item.updatedAt ?? '') >= requestTimelineAt);
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
  if (typeof item.payload.requestAnswerId === 'string') return false;
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

function scrollToLatest(container: Pick<HTMLElement, 'scrollHeight' | 'scrollTo'>): void {
  // 自动跟随必须即时定位，避免程序滚动事件被误判为用户主动阅读历史。
  container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
}

function normalizeItemType(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_\-/]+/gu, '');
}
