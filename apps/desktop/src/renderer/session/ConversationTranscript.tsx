import {Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {motion, useReducedMotion} from 'framer-motion';
import {
    activityCategory,
    isActiveSessionTurn,
    isLiveActivityItem,
    isOperationalActivityItem,
    type SessionActivityCategory,
    SessionActivityGroup,
    SessionTurnDuration,
    SessionTurnProcessDisclosure
} from './SessionActivity.js';
import {itemRole, type SessionUiLanguage, ThreadItemView, transcriptItemText} from './ThreadItemView.js';
import {PlanSummary} from './PlanSummary.js';
import type {
    ConversationResource,
    ConversationResourcePreview,
    NativeConversationContentV2Page,
    NativeConversationToolResultPage,
    NativePendingRequest,
    NativeSessionError,
    NativeSessionItemBuffer,
    NativeSessionState,
    NativeTurnFailureSnapshot,
    TurnChangeSet,
    TurnChangeSetOperationResult,
} from './sessionTypes.js';
import {isAssistantDeliverableItem} from './sessionTypes.js';
import type {
    ConversationFileLocation,
    ConversationOpenTarget,
    ConversationResponseAnnotation,
    ConversationResponseTextAnchor
} from '@zeus/shared';
import {useThreadScrollController} from './useThreadScrollController.js';
import {TurnChangeCard} from './TurnChanges.js';
import {visibleQueuedSubmissions} from './QueuedConversationMessages.js';
import {reasoningSummaryStatus, SessionReasoningSummary} from './SessionReasoningSummary.js';
import {AnsweredRequestHistory, isAnsweredUserInputRequest} from './AnsweredRequestHistory.js';
import {useNewItemMotionIds} from '../ui/useNewItemMotion.js';
import {useTranscriptViewportVirtualizer} from './transcriptViewportVirtualizer.js';

export interface ConversationTranscriptProps {
  state: NativeSessionState;
  language: SessionUiLanguage;
  onEditUserItem?: (item: NativeSessionItemBuffer, content: string) => void | Promise<void>;
  onRetryItem?: (item: NativeSessionItemBuffer) => void;
  openPlanItemKey?: string | null;
  onOpenPlan?: (item: NativeSessionItemBuffer) => void;
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
  onReviewTurnChanges?: (changeSet: TurnChangeSet, fileId?: string) => void;
  onOperateTurnChangeSet?: (changeSet: TurnChangeSet, action: 'undo' | 'reapply') => Promise<TurnChangeSetOperationResult>;
  onLatestContentVisibilityChange?: (visible: boolean) => void;
  historyLoading?: boolean;
  creationStatus?: SessionCreationStatus;
  onAddResponseAnnotation?: (anchor: ConversationResponseTextAnchor) => string;
  onUpdateResponseAnnotation?: (id: string, note: string) => void;
  onRemoveResponseAnnotation?: (id: string) => void;
  onOpenSideChat?: (selectedText: string) => void;
  onLoadEarlierHistory?: () => void | Promise<void>;
  onLoadTurnProcess?: (turnId: string) => void | Promise<void>;
  onLoadTurnArtifacts?: (turnId: string) => void | Promise<void>;
  onLoadV2Content?: (handle: string, offset?: number) => Promise<NativeConversationContentV2Page>;
  onLoadV2ToolResult?: (handle: string, offset?: number) => Promise<NativeConversationToolResultPage>;
}

export interface SessionCreationStatus {
  state: 'creating' | 'failed' | 'warning';
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

const emptyResponseAnnotations: ConversationResponseAnnotation[] = [];
const liveTurnLayoutTransition = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };

function useStableOptionalCallback<Arguments extends unknown[], Result>(callback: ((...args: Arguments) => Result) | undefined): ((...args: Arguments) => Result) | undefined {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const stableCallback = useCallback((...args: Arguments): Result => callbackRef.current!(...args), []);
  return callback ? stableCallback : undefined;
}

export function ConversationTranscript(props: ConversationTranscriptProps) {
  const reduceMotion = useReducedMotion();
  const containerRef = useRef<HTMLElement | null>(null);
  const latestContentMarkerRef = useRef<HTMLSpanElement | null>(null);
  const latestMarkerIntersectingRef = useRef(true);
  const latestPositionFrameRef = useRef<number | null>(null);
  const latestPositionSettleFrameRef = useRef<number | null>(null);
  const latestVisibilityFrameRef = useRef<number | null>(null);
  const lastReportedLatestVisibilityRef = useRef<boolean | null>(null);
  const latestVisibilityCallbackRef = useRef(props.onLatestContentVisibilityChange);
  latestVisibilityCallbackRef.current = props.onLatestContentVisibilityChange;
  const historyPrependAnchorRef = useRef<{ frozenCursor: string; rowKey: string | null; topOffset: number | null; scrollHeight: number; scrollTop: number } | null>(null);
  const previousTurnIdRef = useRef<string | null>(null);
  const activeTurnTrackingInitializedRef = useRef(false);
  const scrollController = useThreadScrollController();
  const [returnToLatestVisible, setReturnToLatestVisible] = useState(false);
  const [completedAnnouncement, setCompletedAnnouncement] = useState<{ key: string; text: string } | null>(null);
  const completedAnnouncementTrackerRef = useRef<CompletedItemAnnouncementTracker>({ hydrated: false, lastCompletedKey: null });
  const positionedConversationIdRef = useRef<string | null>(null);
  const trackedUserMessageRef = useRef<{ conversationId: string | null; key: string | null; initialized: boolean }>({ conversationId: null, key: null, initialized: false });
  const awaitingReplyMessageIdsRef = useRef<Set<string>>(new Set());
  const awaitingReplyConversationIdRef = useRef<string | null>(null);
  const [expandedRowKeys, setExpandedRowKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [historyAnchorRowKey, setHistoryAnchorRowKey] = useState<string | null>(null);
  const queuedSubmissions = useMemo(() => visibleQueuedSubmissions(props.state.queue), [props.state.queue]);
  const queuedClientUserMessageIds = useMemo(() => new Set(queuedSubmissions.map((submission) => submission.clientUserMessageId).filter((value): value is string => Boolean(value))), [queuedSubmissions]);
  const projectedItems = useMemo(
    () =>
      props.state.itemOrder
        .map((key) => props.state.items[key])
        .filter((entry): entry is NativeSessionItemBuffer => Boolean(entry) && isVisibleTranscriptItem(entry) && !isUnacceptedQueuedUserItem(entry, props.state, queuedClientUserMessageIds)),
    [props.state.activeTurnId, props.state.itemOrder, props.state.items, queuedClientUserMessageIds],
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
  // 原始思考摘要完整保留在会话状态中；会话记录的当前态选择统一交给行投影处理。
  const items = transcriptItems;
  const historyHydrated = props.state.snapshot !== null;
  const enteringItemIds = useNewItemMotionIds(
    items.map((item) => item.key),
    220,
    historyHydrated,
  );
  const lastUserKey = [...items].reverse().find((entry) => `${entry.type}`.toLocaleLowerCase().includes('user'))?.key;
  const answeredRequests = useMemo(() => props.state.pendingRequests.filter(isAnsweredUserInputRequest), [props.state.pendingRequests]);
  const transcriptRows = useMemo(() => projectTranscriptRows(items, answeredRequests, props.state.activeTurnId), [answeredRequests, items, props.state.activeTurnId]);
  const turnRows = useMemo(() => projectTranscriptTurnRows(transcriptRows, props.state.activeTurnId), [props.state.activeTurnId, transcriptRows]);
  const turnRowKeys = useMemo(() => turnRows.map((row) => row.key), [turnRows]);
  const turnRowsByKey = useMemo(() => new Map(turnRows.map((row) => [row.key, row])), [turnRows]);
  const activeTurnRowKeys = useMemo(() => new Set(turnRows.filter((row) => props.state.activeTurnId && transcriptTurnRowTurnId(row) === props.state.activeTurnId).map((row) => row.key)), [props.state.activeTurnId, turnRows]);
  const pinnedRowKeys = useMemo(() => {
    const pinned = new Set([...activeTurnRowKeys, ...expandedRowKeys]);
    if (focusedRowKey) pinned.add(focusedRowKey);
    if (historyAnchorRowKey) pinned.add(historyAnchorRowKey);
    return pinned;
  }, [activeTurnRowKeys, expandedRowKeys, focusedRowKey, historyAnchorRowKey]);
  const viewportVirtualizer = useTranscriptViewportVirtualizer({
    scopeKey: props.state.conversationId,
    rowKeys: turnRowKeys,
    pinnedRowKeys,
    containerRef,
  });
  const projectedTurnWorkIds = useMemo(() => new Set(turnRows.filter((row): row is TranscriptTurnWorkRow => row.kind === 'turn_work').map((row) => row.turnId)), [turnRows]);
  const lastItemKeyByTurn = useMemo(() => lastVisibleItemKeyByTurn(transcriptRows), [transcriptRows]);
  const orphanFailedTurns = useMemo(() => {
    const visibleTurnIds = new Set(transcriptRows.map(transcriptRowTurnId).filter((turnId): turnId is string => Boolean(turnId)));
    return Object.values(props.state.turnsByProviderId)
      .filter((turn) => turn.status === 'failed' && turn.error && !visibleTurnIds.has(turn.providerTurnId ?? ''))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }, [props.state.turnsByProviderId, transcriptRows]);
  const showActiveStatus = shouldShowTranscriptThinking(props.state, items);
  const motionFocus = resolveSessionMotionFocus(props.state, transcriptItems, showActiveStatus);
  const activeStatusKind = props.state.conversationState === 'starting_turn' ? 'starting' : 'thinking';
  const creatingSession = props.creationStatus?.state === 'creating';
  const realTurnStarted = Boolean(props.state.activeTurnId);
  // 创建期只保留一个主进度：真实轮次建立前显示连接，建立后由轮次状态或真实过程内容接管。
  const showCreationStatus = Boolean(props.creationStatus) && !(creatingSession && realTurnStarted);
  const showStandaloneActiveStatus = showActiveStatus && !(creatingSession && !realTurnStarted);
  const historyUnavailable = !historyHydrated && (props.state.transportState === 'reconnecting' || props.state.transportState === 'failed');
  const awaitingReplyMessageIdsKey = items
    .filter(isOptimisticMessageAwaitingReply)
    .map((item) => item.clientUserMessageId)
    .filter((value): value is string => Boolean(value))
    .join('\u0000');
  const awaitingReplyMessageIds = useMemo(() => (awaitingReplyMessageIdsKey ? awaitingReplyMessageIdsKey.split('\u0000') : []), [awaitingReplyMessageIdsKey]);
  const latestSubmittedMessageId = awaitingReplyMessageIds.at(-1) ?? null;
  const responseAnnotationsByItemId = useMemo(() => {
    const byItemId = new Map<string, ConversationResponseAnnotation[]>();
    for (const annotation of props.state.contextDraft.responseAnnotations) {
      const annotations = byItemId.get(annotation.anchor.itemId);
      if (annotations) annotations.push(annotation);
      else byItemId.set(annotation.anchor.itemId, [annotation]);
    }
    return byItemId;
  }, [props.state.contextDraft.responseAnnotations]);
  const renderProps: ConversationTranscriptProps = {
    ...props,
    onEditUserItem: useStableOptionalCallback(props.onEditUserItem),
    onRetryItem: useStableOptionalCallback(props.onRetryItem),
    onOpenPlan: useStableOptionalCallback(props.onOpenPlan),
    onOpenResource: useStableOptionalCallback(props.onOpenResource),
    onLoadResourcePreview: useStableOptionalCallback(props.onLoadResourcePreview),
    onReviewTurnChanges: useStableOptionalCallback(props.onReviewTurnChanges),
    onOperateTurnChangeSet: useStableOptionalCallback(props.onOperateTurnChangeSet),
    onAddResponseAnnotation: useStableOptionalCallback(props.onAddResponseAnnotation),
    onUpdateResponseAnnotation: useStableOptionalCallback(props.onUpdateResponseAnnotation),
    onRemoveResponseAnnotation: useStableOptionalCallback(props.onRemoveResponseAnnotation),
    onOpenSideChat: useStableOptionalCallback(props.onOpenSideChat),
    onLoadEarlierHistory: useStableOptionalCallback(props.onLoadEarlierHistory),
    onLoadTurnProcess: useStableOptionalCallback(props.onLoadTurnProcess),
    onLoadTurnArtifacts: useStableOptionalCallback(props.onLoadTurnArtifacts),
    onLoadV2Content: useStableOptionalCallback(props.onLoadV2Content),
    onLoadV2ToolResult: useStableOptionalCallback(props.onLoadV2ToolResult),
  };
  const loadEarlierHistoryWithAnchor = useCallback(async (): Promise<void> => {
    const loadEarlier = renderProps.onLoadEarlierHistory;
    const container = containerRef.current;
    const frozenCursor = props.state.snapshot?.v2Paging?.history.nextCursor;
    if (!loadEarlier || !container || !frozenCursor || historyPrependAnchorRef.current) return;
    const anchorElement = firstVisibleTranscriptWindowRow(container);
    const containerTop = container.getBoundingClientRect().top;
    const rowKey = anchorElement?.dataset.transcriptRowKey ?? null;
    const anchor = {
      frozenCursor,
      rowKey,
      topOffset: anchorElement ? anchorElement.getBoundingClientRect().top - containerTop : null,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
    };
    historyPrependAnchorRef.current = anchor;
    setHistoryAnchorRowKey(rowKey);
    try {
      await loadEarlier();
    } catch (error) {
      if (historyPrependAnchorRef.current === anchor) {
        historyPrependAnchorRef.current = null;
        setHistoryAnchorRowKey(null);
      }
      throw error;
    }
  }, [props.state.snapshot?.v2Paging?.history.nextCursor, renderProps.onLoadEarlierHistory]);

  useLayoutEffect(() => {
    const anchor = historyPrependAnchorRef.current;
    const container = containerRef.current;
    if (!anchor || !container || props.state.snapshot?.v2Paging?.history.loading) return;
    const anchorElement = anchor.rowKey ? transcriptWindowRow(container, anchor.rowKey) : null;
    if (anchorElement && anchor.topOffset !== null) {
      const nextOffset = anchorElement.getBoundingClientRect().top - container.getBoundingClientRect().top;
      container.scrollTop += nextOffset - anchor.topOffset;
    } else {
      container.scrollTop = anchor.scrollTop + Math.max(0, container.scrollHeight - anchor.scrollHeight);
    }
    historyPrependAnchorRef.current = null;
    setHistoryAnchorRowKey(null);
    viewportVirtualizer.synchronizeViewport(container);
  }, [props.state.itemOrder.length, props.state.snapshot?.v2Paging?.history.loading, props.state.snapshot?.v2Paging?.history.nextCursor]);

  const publishLatestContentVisibility = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const current = metrics(container);
    const visible = current.scrollHeight - current.scrollTop - current.clientHeight <= 24 && latestMarkerIntersectingRef.current;
    if (lastReportedLatestVisibilityRef.current === visible) return;
    lastReportedLatestVisibilityRef.current = visible;
    latestVisibilityCallbackRef.current?.(visible);
  }, []);

  const scheduleLatestContentVisibility = useCallback(() => {
    if (latestVisibilityFrameRef.current !== null) return;
    latestVisibilityFrameRef.current = requestAnimationFrame(() => {
      latestVisibilityFrameRef.current = null;
      publishLatestContentVisibility();
    });
  }, [publishLatestContentVisibility]);

  const maintainLatestPosition = useCallback(() => {
    if (latestPositionFrameRef.current !== null) return;
    latestPositionFrameRef.current = requestAnimationFrame(() => {
      latestPositionFrameRef.current = null;
      const container = containerRef.current;
      if (!container) return;
      const effect = scrollController.onDelta();
      if (effect.type === 'scroll_to_bottom') {
        scrollToLatest(container, latestContentMarkerRef.current);
        setReturnToLatestVisible(false);
      }
      scheduleLatestContentVisibility();
    });
  }, [scheduleLatestContentVisibility, scrollController]);

  const settleLatestPosition = useCallback(() => {
    if (latestPositionSettleFrameRef.current !== null) cancelAnimationFrame(latestPositionSettleFrameRef.current);
    let remainingFrames = 3;
    const settle = (): void => {
      latestPositionSettleFrameRef.current = null;
      const container = containerRef.current;
      if (!container) return;
      const effect = scrollController.onDelta();
      if (effect.type === 'scroll_to_bottom') {
        scrollToLatest(container, latestContentMarkerRef.current);
        setReturnToLatestVisible(false);
      }
      scheduleLatestContentVisibility();
      remainingFrames -= 1;
      if (remainingFrames > 0) latestPositionSettleFrameRef.current = requestAnimationFrame(settle);
    };
    latestPositionSettleFrameRef.current = requestAnimationFrame(settle);
  }, [scheduleLatestContentVisibility, scrollController]);

  useEffect(() => {
    const container = containerRef.current;
    const marker = latestContentMarkerRef.current;
    if (!container || !marker || typeof IntersectionObserver === 'undefined') {
      latestMarkerIntersectingRef.current = true;
      scheduleLatestContentVisibility();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        latestMarkerIntersectingRef.current = entries[0]?.isIntersecting ?? false;
        scheduleLatestContentVisibility();
      },
      { root: container, threshold: 0 },
    );
    observer.observe(marker);
    scheduleLatestContentVisibility();
    return () => observer.disconnect();
  }, [scheduleLatestContentVisibility]);

  useEffect(
    () => () => {
      if (latestPositionFrameRef.current !== null) cancelAnimationFrame(latestPositionFrameRef.current);
      if (latestPositionSettleFrameRef.current !== null) cancelAnimationFrame(latestPositionSettleFrameRef.current);
      if (latestVisibilityFrameRef.current !== null) cancelAnimationFrame(latestVisibilityFrameRef.current);
      lastReportedLatestVisibilityRef.current = false;
      latestVisibilityCallbackRef.current?.(false);
    },
    [],
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    const conversationId = props.state.conversationId;
    if (!container || !historyHydrated || !conversationId || positionedConversationIdRef.current === conversationId) return;
    positionedConversationIdRef.current = conversationId;
    scrollToLatest(container, latestContentMarkerRef.current);
    settleLatestPosition();
    setReturnToLatestVisible(false);
  }, [historyHydrated, props.state.conversationId, props.state.transcriptRevision, settleLatestPosition]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const conversationId = props.state.conversationId;
    if (awaitingReplyConversationIdRef.current !== conversationId) {
      awaitingReplyConversationIdRef.current = conversationId;
      awaitingReplyMessageIdsRef.current = new Set();
    }
    const previousIds = awaitingReplyMessageIdsRef.current;
    const newlyAwaitingIds = awaitingReplyMessageIds.filter((clientId) => !previousIds.has(clientId));
    awaitingReplyMessageIdsRef.current = new Set(awaitingReplyMessageIds);
    const newestSubmittedMessageId = newlyAwaitingIds.at(-1);
    if (!container || !newestSubmittedMessageId) return;
    // 首次水合带回的旧排队消息只按普通历史定位；只有当前工作面明确提交的新消息才建立新轮次锚点。
    if (historyHydrated && !activeTurnTrackingInitializedRef.current) return;
    const effect = scrollController.onMessageSubmitted();
    if (effect.type === 'scroll_to_bottom') {
      scrollToLatest(container, latestContentMarkerRef.current);
      setReturnToLatestVisible(false);
    }
  }, [awaitingReplyMessageIds, historyHydrated, props.state.conversationId, scrollController]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const conversationId = props.state.conversationId;
    if (!container || !historyHydrated || !conversationId) return;
    const tracked = trackedUserMessageRef.current;
    if (!tracked.initialized || tracked.conversationId !== conversationId) {
      trackedUserMessageRef.current = { conversationId, key: lastUserKey ?? null, initialized: true };
      return;
    }
    const previousKey = tracked.key;
    tracked.key = lastUserKey ?? null;
    if (!lastUserKey || lastUserKey === previousKey) return;

    // 以可见用户消息身份作为发送锚点，覆盖“发送后很快被 accepted/完成，来不及进入 awaitingReply 列表”的快速路径。
    const effect = scrollController.onMessageSubmitted();
    if (effect.type === 'scroll_to_bottom') {
      scrollToLatest(container, latestContentMarkerRef.current);
      setReturnToLatestVisible(false);
      settleLatestPosition();
    }
  }, [historyHydrated, lastUserKey, props.state.conversationId, scrollController, settleLatestPosition]);

  useEffect(() => {
    const resolution = resolveCompletedItemAnnouncement(completedAnnouncementTrackerRef.current, items, props.language);
    completedAnnouncementTrackerRef.current = resolution.tracker;
    if (resolution.announcement) setCompletedAnnouncement(resolution.announcement);
  }, [items, props.language, props.state.transcriptRevision]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !historyHydrated) return;
    if (!activeTurnTrackingInitializedRef.current) {
      // 首次水合得到的活动轮次属于既有会话现场，不能误当成当前页面刚开始的新轮次。
      activeTurnTrackingInitializedRef.current = true;
      previousTurnIdRef.current = props.state.activeTurnId;
      return;
    }
    if (props.state.activeTurnId && previousTurnIdRef.current !== props.state.activeTurnId) {
      const effect = scrollController.onTurnStarted(metrics(container), Date.now());
      if (effect.type === 'scroll_to_bottom') {
        scrollToLatest(container, latestContentMarkerRef.current);
        setReturnToLatestVisible(false);
      }
    }
    previousTurnIdRef.current = props.state.activeTurnId;
  }, [historyHydrated, latestSubmittedMessageId, props.state.activeTurnId, scrollController]);

  useLayoutEffect(() => {
    maintainLatestPosition();
  }, [maintainLatestPosition, props.creationStatus?.error, props.creationStatus?.state, props.state.transcriptRevision]);

  const setTranscriptRowExpanded = useCallback((rowKey: string, open: boolean): void => {
    setExpandedRowKeys((current) => {
      if (current.has(rowKey) === open) return current;
      const next = new Set(current);
      if (open) next.add(rowKey);
      else next.delete(rowKey);
      return next;
    });
  }, []);

  const renderTranscriptTurnRow = (row: TranscriptTurnRow): ReactNode => {
    if (row.kind === 'answered_request') return <AnsweredRequestHistory request={row.request} language={props.language} />;
    if (row.kind === 'turn_work') {
      const turn = props.state.turnsByProviderId[row.turnId];
      if (!turn) {
        return row.rows.map((child) => (
          <Fragment key={child.key}>
            {renderTranscriptRow(child, transcriptRowRenderOptions(renderProps, items, showActiveStatus, motionFocus, lastUserKey, true, enteringItemIds, maintainLatestPosition, responseAnnotationsByItemId))}
          </Fragment>
        ));
      }
      const containsLastItem = row.rows.some((child) => transcriptRowContainsItemKey(child, lastItemKeyByTurn[row.turnId]));
      const active = isActiveSessionTurn(turn);
      const v2PagingKey = turn.providerTurnId ?? turn.id;
      const processPaging = props.state.snapshot?.v2Paging?.processByTurn[v2PagingKey];
      const changePaging = props.state.snapshot?.v2Paging?.changeSetsByTurn[v2PagingKey];
      const process = row.rows.map((child) => {
        const content = renderTranscriptRow(
          child,
          transcriptRowRenderOptions(renderProps, items, showActiveStatus && props.state.activeTurnId === row.turnId, motionFocus, lastUserKey, true, enteringItemIds, maintainLatestPosition, responseAnnotationsByItemId),
        );
        return active ? (
          <motion.div className="session-live-turn-row" key={child.key} layout={reduceMotion ? false : 'position'} transition={reduceMotion ? { duration: 0 } : liveTurnLayoutTransition}>
            {content}
          </motion.div>
        ) : (
          <Fragment key={child.key}>{content}</Fragment>
        );
      });
      return (
        <>
          {active ? (
            <SessionTurnDuration turn={turn} requests={props.state.pendingRequests} language={props.language}>
              {process}
            </SessionTurnDuration>
          ) : (
            <SessionTurnProcessDisclosure
              language={props.language}
              loading={Boolean(processPaging?.loading || changePaging?.loading || props.state.snapshot?.v2Paging?.resources.loading)}
              error={processPaging?.error ?? changePaging?.error ?? props.state.snapshot?.v2Paging?.resources.error}
              open={expandedRowKeys.has(row.key)}
              onOpenChange={(open) => setTranscriptRowExpanded(row.key, open)}
              onOpen={() => Promise.all([renderProps.onLoadTurnProcess?.(row.turnId), renderProps.onLoadTurnArtifacts?.(row.turnId)]).then(() => undefined)}
            >
              {process}
              {processPaging?.loaded && processPaging.hasMore && renderProps.onLoadTurnProcess ? (
                  <V2AutoPageSentinel loading={processPaging.loading} error={processPaging.error} kind="process"
                                      language={props.language}
                                      onLoad={() => renderProps.onLoadTurnProcess?.(row.turnId)}/>
              ) : null}
              <V2TurnDeferredArtifacts
                state={props.state}
                localTurnId={turn.id}
                pagingKey={v2PagingKey}
                language={props.language}
                onLoadMore={renderProps.onLoadTurnArtifacts ? () => renderProps.onLoadTurnArtifacts?.(row.turnId) : undefined}
                onLoadContent={renderProps.onLoadV2Content}
                onLoadToolResult={renderProps.onLoadV2ToolResult}
              />
            </SessionTurnProcessDisclosure>
          )}
          {!active && containsLastItem ? (
            <>
              {renderTurnArtifacts(row.turnId, renderProps, lastItemKeyByTurn[row.turnId], providerErrorItemsByTurn.get(row.turnId))}
              <SessionTurnDuration turn={turn} requests={props.state.pendingRequests} language={props.language} />
            </>
          ) : null}
        </>
      );
    }
    const rowItems = row.kind === 'item' ? [row.item] : row.items;
    const lastRowItem = rowItems[rowItems.length - 1]!;
    const turn = props.state.turnsByProviderId[lastRowItem.turnId];
    const closesVisibleTurn = lastItemKeyByTurn[lastRowItem.turnId] === lastRowItem.key;
    const v2PagingKey = turn?.providerTurnId ?? turn?.id ?? lastRowItem.turnId;
    const v2ProcessPaging = props.state.snapshot?.v2Paging?.processByTurn[v2PagingKey];
    const v2ChangePaging = props.state.snapshot?.v2Paging?.changeSetsByTurn[v2PagingKey];
    const v2Turn = props.state.snapshot?.snapshotV2
      ? [...props.state.snapshot.snapshotV2.recentClosedTurns, ...(props.state.snapshot.snapshotV2.activeTurn ? [props.state.snapshot.snapshotV2.activeTurn] : [])].find(
          (candidate) => candidate.id === turn?.id || (turn?.providerTurnId && candidate.providerTurnId === turn.providerTurnId),
        )
      : undefined;
    const showV2DeferredDetails = Boolean(
      closesVisibleTurn && turn && v2Turn && !isActiveSessionTurn(turn) && !projectedTurnWorkIds.has(lastRowItem.turnId) && (v2Turn.process.available || v2Turn.resourcesAvailable || v2Turn.changeSetAvailable),
    );
    return (
      <>
        {renderTranscriptRow(row, transcriptRowRenderOptions(renderProps, items, showActiveStatus, motionFocus, lastUserKey, false, enteringItemIds, maintainLatestPosition, responseAnnotationsByItemId))}
        {showV2DeferredDetails && turn ? (
          <SessionTurnProcessDisclosure
            language={props.language}
            labelKind="details"
            loading={Boolean(v2ProcessPaging?.loading || v2ChangePaging?.loading || props.state.snapshot?.v2Paging?.resources.loading)}
            error={v2ProcessPaging?.error ?? v2ChangePaging?.error ?? props.state.snapshot?.v2Paging?.resources.error}
            open={expandedRowKeys.has(row.key)}
            onOpenChange={(open) => setTranscriptRowExpanded(row.key, open)}
            onOpen={() => Promise.all([renderProps.onLoadTurnProcess?.(lastRowItem.turnId), renderProps.onLoadTurnArtifacts?.(lastRowItem.turnId)]).then(() => undefined)}
          >
            <V2TurnDeferredArtifacts
              state={props.state}
              localTurnId={turn.id}
              pagingKey={v2PagingKey}
              language={props.language}
              onLoadMore={renderProps.onLoadTurnArtifacts ? () => renderProps.onLoadTurnArtifacts?.(lastRowItem.turnId) : undefined}
              onLoadContent={renderProps.onLoadV2Content}
              onLoadToolResult={renderProps.onLoadV2ToolResult}
            />
          </SessionTurnProcessDisclosure>
        ) : null}
        {closesVisibleTurn ? renderTurnArtifacts(lastRowItem.turnId, renderProps, lastRowItem.key, providerErrorItemsByTurn.get(lastRowItem.turnId)) : null}
        {closesVisibleTurn && turn && !isActiveSessionTurn(turn) ? <SessionTurnDuration turn={turn} requests={props.state.pendingRequests} language={props.language} /> : null}
      </>
    );
  };

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
            viewportVirtualizer.synchronizeViewport(event.currentTarget);
            scheduleLatestContentVisibility();
          }}
        >
          <V2HistoryPageControl state={props.state} language={props.language} onLoadEarlier={renderProps.onLoadEarlierHistory ? loadEarlierHistoryWithAnchor : undefined} />
          {turnRows.length > 0 ? (
            <div className="session-transcript-window" data-rendered-row-count={viewportVirtualizer.projection.renderedRowCount} data-total-row-count={turnRows.length} data-measurement-cache-count={viewportVirtualizer.measurementCacheSize}>
              {viewportVirtualizer.projection.slots.map((slot) => {
                if (slot.kind === 'spacer') {
                  return <div key={slot.key} className="session-transcript-window-spacer" style={{ blockSize: slot.height }} aria-hidden="true" />;
                }
                const row = turnRowsByKey.get(slot.rowKey);
                if (!row) return null;
                return (
                  <div
                    key={slot.key}
                    ref={viewportVirtualizer.rowRef(row.key)}
                    className="session-transcript-window-row"
                    data-transcript-row-key={row.key}
                    data-pinned={pinnedRowKeys.has(row.key) || undefined}
                    onFocusCapture={() => setFocusedRowKey(row.key)}
                    onBlurCapture={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) setFocusedRowKey((current) => (current === row.key ? null : current));
                    }}
                  >
                    {renderTranscriptTurnRow(row)}
                  </div>
                );
              })}
            </div>
          ) : !showActiveStatus && queuedSubmissions.length === 0 && historyHydrated ? (
            <p className="session-transcript-empty">{props.language === 'zh-CN' ? '发送第一条消息后，真实 app-server 对话会显示在这里。' : 'Send the first message to begin the real app-server transcript.'}</p>
          ) : !showActiveStatus && historyUnavailable ? (
            <p className="session-transcript-empty" role="status">
              {props.language === 'zh-CN' ? '历史消息暂不可用；连接恢复后会自动显示。' : 'History is temporarily unavailable and will reappear after the connection recovers.'}
            </p>
          ) : null}
          {orphanFailedTurns.map((turn) => (
            <TurnFailureCard key={`turn-failure:${turn.providerTurnId ?? turn.id}`} failure={turn.error!} language={props.language} providerErrors={providerErrorItemsByTurn.get(turn.providerTurnId ?? '')} />
          ))}
          {showCreationStatus && props.creationStatus ? <SessionCreationNotice status={props.creationStatus} language={props.language} /> : null}
          {showStandaloneActiveStatus && motionFocus?.kind === 'thinking' ? <TranscriptActiveStatus language={props.language} kind={activeStatusKind} /> : null}
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
            scrollToLatest(container, latestContentMarkerRef.current);
            setReturnToLatestVisible(false);
          }}
        >
          {props.language === 'zh-CN' ? '返回最新消息' : 'Return to latest'}
        </button>
        <TranscriptHistoryLoading visible={Boolean(props.historyLoading)} language={props.language} />
      </div>
    </>
  );
}

function TranscriptHistoryLoading(props: { visible: boolean; language: SessionUiLanguage }) {
  return (
    <section className="session-transcript-loading" data-visible={props.visible || undefined} role={props.visible ? 'status' : undefined} aria-hidden={!props.visible} aria-live={props.visible ? 'polite' : undefined}>
      <span className="session-loading-line" />
      <span className="session-loading-line" />
      <strong>{props.language === 'zh-CN' ? '正在加载会话' : 'Loading conversation'}</strong>
    </section>
  );
}

function V2HistoryPageControl(props: { state: NativeSessionState; language: SessionUiLanguage; onLoadEarlier?: () => void | Promise<void> }) {
  const paging = props.state.snapshot?.v2Paging?.history;
    const sentinelRef = useRef<HTMLElement | null>(null);
    const cursor = paging?.nextCursor ?? null;
    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel || !cursor || !paging?.hasMore || paging.loading || paging.error || !props.onLoadEarlier) return;
        let requested = false;
        const requestPage = (): void => {
            if (requested) return;
            requested = true;
            void Promise.resolve(props.onLoadEarlier?.()).catch(() => undefined);
        };
        if (typeof IntersectionObserver === 'undefined') {
            requestPage();
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) requestPage();
            },
            {root: sentinel.closest('.session-transcript'), rootMargin: '180px 0px 0px'},
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [cursor, paging?.error, paging?.hasMore, paging?.loading, props.onLoadEarlier]);
  if (!props.state.snapshot?.snapshotV2 || !paging || (!paging.hasMore && !paging.error)) return null;
  return (
      <section ref={sentinelRef} className="session-v2-history-control" aria-busy={paging.loading || undefined}>
          {paging.loading ? <small
              className="session-v2-page-status">{props.language === 'zh-CN' ? '正在读取更早消息…' : 'Loading earlier messages…'}</small> : null}
      {paging.error ? (
        <small className="session-v2-page-error" role="alert">
            {props.language === 'zh-CN' ? '更早消息暂时无法读取。' : 'Earlier messages are temporarily unavailable.'}
        </small>
      ) : null}
    </section>
  );
}

function V2TurnDeferredArtifacts(props: {
  state: NativeSessionState;
  localTurnId: string;
  pagingKey: string;
  language: SessionUiLanguage;
  onLoadMore?: () => void | Promise<void>;
  onLoadContent?: (handle: string, offset?: number) => Promise<NativeConversationContentV2Page>;
  onLoadToolResult?: (handle: string, offset?: number) => Promise<NativeConversationToolResultPage>;
}) {
  const paging = props.state.snapshot?.v2Paging;
  if (!props.state.snapshot?.snapshotV2 || !paging) return null;
  const resources = paging.resources.items.filter((resource) => resource.turnId === props.localTurnId);
  const change = paging.changeSetsByTurn[props.pagingKey];
  const deferredContent = deferredContentHandles(props.state, props.pagingKey);
  const onLoadContent = props.onLoadContent;
  const onLoadToolResult = props.onLoadToolResult;
  const visible = resources.length > 0 || Boolean(change?.summary) || (change?.files.length ?? 0) > 0 || deferredContent.length > 0;
  if (!visible && !change?.error && !paging.resources.error) return null;
  const canLoadMore = Boolean(props.onLoadMore && (paging.resources.hasMore || change?.hasMore));
  return (
    <section className="session-v2-deferred-artifacts" aria-label={props.language === 'zh-CN' ? '按需加载的轮次详情' : 'On-demand turn details'}>
      {resources.length > 0 ? (
        <div>
          <strong>{props.language === 'zh-CN' ? '资源元数据' : 'Resource metadata'}</strong>
          <ul>
            {resources.map((resource) => (
              <li key={resource.id}>
                <span>{resource.displayName}</span>
                <small>{resource.kind}</small>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {change?.summary ? (
        <div>
          <strong>{props.language === 'zh-CN' ? '变更集' : 'Change set'}</strong>
          <p>
            {props.language === 'zh-CN'
              ? `${change.summary.fileCount} 个文件 · +${change.summary.addedLines} / -${change.summary.deletedLines}`
              : `${change.summary.fileCount} files · +${change.summary.addedLines} / -${change.summary.deletedLines}`}
          </p>
          {change.files.length > 0 ? (
            <ul>
              {change.files.map((file) => (
                <li key={file.id}>
                  <span>{file.newPath ?? file.oldPath ?? file.id}</span>
                  <small>
                    +{file.addedLines} / -{file.deletedLines}
                  </small>
                  {file.diffHandle && onLoadContent ? <V2DeferredContent handle={file.diffHandle} label={props.language === 'zh-CN' ? '查看差异' : 'View diff'} language={props.language} onLoad={onLoadContent} /> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {deferredContent.some((content) => (content.kind === 'tool_result' ? Boolean(onLoadToolResult) : Boolean(onLoadContent))) ? (
        <div>
            <strong>{props.language === 'zh-CN' ? '完整正文与工具结果' : 'Full content and tool results'}</strong>
          <ul>
            {deferredContent.flatMap((content) => {
              const onLoad = content.kind === 'tool_result' ? onLoadToolResult : onLoadContent;
              return onLoad
                ? [
                    <li key={`${content.kind}:${content.handle}`}>
                      <span>{content.label}</span>
                      <V2DeferredContent handle={content.handle} label={props.language === 'zh-CN' ? '读取正文' : 'Load content'} language={props.language} onLoad={onLoad} />
                    </li>,
                  ]
                : [];
            })}
          </ul>
        </div>
      ) : null}
        {canLoadMore ? <V2AutoPageSentinel loading={Boolean(change?.loading || paging.resources.loading)}
                                           error={change?.error ?? paging.resources.error} kind="artifacts"
                                           language={props.language} onLoad={props.onLoadMore!}/> : null}
    </section>
  );
}

function V2AutoPageSentinel(props: {
    loading: boolean;
    error: string | null | undefined;
    kind: 'process' | 'artifacts';
    language: SessionUiLanguage;
    onLoad: () => void | Promise<void>
}) {
    const sentinelRef = useRef<HTMLSpanElement | null>(null);
    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel || props.loading || props.error) return;
        let requested = false;
        const requestPage = (): void => {
            if (requested) return;
            requested = true;
            void Promise.resolve(props.onLoad()).catch(() => undefined);
        };
        if (typeof IntersectionObserver === 'undefined') {
            requestPage();
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) requestPage();
            },
            {root: sentinel.closest('.session-transcript'), rootMargin: '240px 0px'},
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [props.error, props.loading, props.onLoad]);
    const loadingLabel = props.kind === 'process' ? (props.language === 'zh-CN' ? '正在补齐处理过程…' : 'Loading process…') : props.language === 'zh-CN' ? '正在补齐资源与变更…' : 'Loading resources and changes…';
    const errorLabel =
        props.kind === 'process' ? (props.language === 'zh-CN' ? '处理过程暂时无法读取。' : 'Process is temporarily unavailable.') : props.language === 'zh-CN' ? '资源与变更暂时无法读取。' : 'Resources and changes are temporarily unavailable.';
    return (
        <span ref={sentinelRef} className="session-v2-auto-page" role={props.loading ? 'status' : undefined}>
      {props.loading ? loadingLabel : null}
            {props.error ? errorLabel : null}
    </span>
    );
}

interface V2DeferredContentPage {
  text: string;
  offset: number;
  nextOffset: number | null;
  totalCharacters: number;
  redacted?: boolean;
}

function V2DeferredContent(props: { handle: string; label: string; language: SessionUiLanguage; onLoad: (handle: string, offset?: number) => Promise<V2DeferredContentPage> }) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const loadingRef = useRef(false);
    const [pages, setPages] = useState<V2DeferredContentPage[]>([]);
  const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState(false);
  useEffect(() => {
      loadingRef.current = false;
      setPages([]);
    setLoading(false);
      setFailed(false);
  }, [props.handle]);
    const load = useCallback(
        async (offset?: number): Promise<void> => {
            if (loadingRef.current) return;
            loadingRef.current = true;
            setLoading(true);
            setFailed(false);
            try {
                const page = await props.onLoad(props.handle, offset);
                setPages((current) => (offset === undefined ? [page] : [...current.filter((candidate) => candidate.offset !== page.offset), page].sort((left, right) => left.offset - right.offset)));
            } catch {
                setFailed(true);
            } finally {
                loadingRef.current = false;
                setLoading(false);
            }
        },
        [props.handle, props.onLoad],
    );
    useEffect(() => {
        const root = rootRef.current;
        if (!root || pages.length > 0 || loading || failed) return;
        let requested = false;
        const requestContent = (): void => {
            if (requested) return;
            requested = true;
            void load();
        };
        if (typeof IntersectionObserver === 'undefined') {
            requestContent();
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) requestContent();
            },
            {root: root.closest('.session-transcript'), rootMargin: '240px 0px'},
        );
        observer.observe(root);
        return () => observer.disconnect();
    }, [failed, load, loading, pages.length]);
    const lastPage = pages.at(-1) ?? null;
    const text = pages.map((page) => page.text).join('');
  return (
      <div ref={rootRef} className="session-v2-content" aria-label={props.label} aria-busy={loading || undefined}>
          {loading && pages.length === 0 ? <small
              className="session-v2-page-status">{props.language === 'zh-CN' ? '正在读取正文…' : 'Loading content…'}</small> : null}
          {lastPage ? (
              <>
                  <pre>{text}</pre>
                  <small>
                      {pages.some((page) => page.redacted === true) ? (props.language === 'zh-CN' ? '敏感内容已脱敏 · ' : 'Sensitive content redacted · ') : ''}
                      {lastPage.nextOffset ?? lastPage.totalCharacters}/{lastPage.totalCharacters}
                  </small>
                  {lastPage.nextOffset !== null ? (
                      <button type="button" disabled={loading}
                              onClick={() => void load(lastPage.nextOffset ?? undefined)}>
                          {loading ? (props.language === 'zh-CN' ? '正在展开…' : 'Expanding…') : props.language === 'zh-CN' ? '展开剩余内容' : 'Expand remaining content'}
                      </button>
                  ) : null}
              </>
          ) : null}
          {failed ? (
        <small className="session-v2-page-error" role="alert">
            {props.language === 'zh-CN' ? '正文暂时无法读取。' : 'Content is temporarily unavailable.'}
        </small>
      ) : null}
    </div>
  );
}

function deferredContentHandles(state: NativeSessionState, turnId: string): Array<{ handle: string; label: string; kind: 'content' | 'tool_result' }> {
  const byHandle = new Map<string, { handle: string; label: string; kind: 'content' | 'tool_result' }>();
  for (const item of Object.values(state.items)) {
    if (item.turnId !== turnId) continue;
    const detailHandle = primitiveValue(item.payload.v2ContentHandle);
      const contentKind = primitiveValue(item.payload.v2ContentKind);
      if (detailHandle && contentKind === 'model_history' && item.payload.v2ContentTruncated === true) {
      byHandle.set(detailHandle, { handle: detailHandle, label: primitiveValue(item.payload.title) ?? item.text ?? item.type, kind: 'content' });
    }
    const toolResult = recordValue(item.payload.toolResult);
    const toolHandle = primitiveValue(toolResult?.handle);
    if (toolHandle) byHandle.set(toolHandle, { handle: toolHandle, label: propsLabelForToolResult(item), kind: 'tool_result' });
  }
  return [...byHandle.values()];
}

function propsLabelForToolResult(item: NativeSessionItemBuffer): string {
  return primitiveValue(item.payload.title) ?? item.text ?? 'Tool result';
}

function SessionCreationNotice(props: { status: SessionCreationStatus; language: SessionUiLanguage }) {
  return (
    <section className={`session-creation-status is-${props.status.state}`} role={props.status.state === 'creating' ? 'status' : 'alert'} aria-live="polite">
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
      {props.status.state !== 'creating' && props.status.onRetry ? (
        <button type="button" onClick={() => void props.status.onRetry?.()}>
          {props.status.retryLabel ?? (props.language === 'zh-CN' ? '重试' : 'Retry')}
        </button>
      ) : null}
    </section>
  );
}

function TurnFailureCard(props: { failure: NativeTurnFailureSnapshot; language: SessionUiLanguage; providerErrors?: readonly NativeSessionItemBuffer[] }) {
  const zh = props.language === 'zh-CN';
  const warning = props.failure.code === 'ZEUS_PI_MODEL_REQUEST_FAILED';
  const copy = failureCopy(props.failure.category, zh);
  const providerDetails = (props.providerErrors ?? []).map(providerErrorDetails);
  return (
    <article
      className="session-turn-failure"
      data-severity={warning ? 'warning' : 'error'}
      role={warning ? 'status' : 'alert'}
      aria-label={warning ? (zh ? '模型请求警告' : 'Model request warning') : zh ? '会话失败原因' : 'Conversation failure reason'}
    >
      <strong>{warning ? (zh ? '本轮请求未完成，会话可以继续' : 'This request did not complete; the conversation can continue') : zh ? '本轮执行失败' : 'This turn failed'}</strong>
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
      ? { reason: '登录状态或 API Key 未通过认证，模型服务拒绝了本轮请求。', recovery: '请完成对应运行内核的登录，或检查模型供应商中的 API Key，然后重新发送。' }
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
      category: SessionActivityCategory;
      motionActive: boolean;
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
  motionFocus: SessionMotionFocus;
  lastUserKey: string | undefined;
  insideWork: boolean;
  enteringItemIds: ReadonlySet<string>;
  onVisibleContentChange: () => void;
  responseAnnotationsByItemId: ReadonlyMap<string, ConversationResponseAnnotation[]>;
}

function transcriptRowRenderOptions(
  props: ConversationTranscriptProps,
  items: readonly NativeSessionItemBuffer[],
  showThinking: boolean,
  motionFocus: SessionMotionFocus,
  lastUserKey: string | undefined,
  insideWork: boolean,
  enteringItemIds: ReadonlySet<string>,
  onVisibleContentChange: () => void,
  responseAnnotationsByItemId: ReadonlyMap<string, ConversationResponseAnnotation[]>,
): TranscriptRowRenderOptions {
  return { props, items, showThinking, motionFocus, lastUserKey, insideWork, enteringItemIds, onVisibleContentChange, responseAnnotationsByItemId };
}

function renderTranscriptRow(row: TranscriptRow, options: TranscriptRowRenderOptions): ReactNode {
  if (row.kind === 'answered_request') return <AnsweredRequestHistory request={row.request} language={options.props.language} />;
  if (row.kind === 'activity') {
    return (
      <SessionActivityGroup
        items={row.items}
        category={row.category}
        language={options.props.language}
        motionActive={row.motionActive || row.items.some(isLiveActivityItem) || row.items.some((item) => item.key === options.motionFocus?.itemKey)}
      />
    );
  }
  if (row.item.type === 'plan') {
    return <PlanSummary item={row.item} language={options.props.language} motionActive={row.item.key === options.motionFocus?.itemKey} panelOpen={options.props.openPlanItemKey === row.item.key} onOpenPanel={options.props.onOpenPlan} />;
  }
  if (normalizeItemType(row.item.type) === 'reasoning') {
    return (
      <SessionReasoningSummary
        item={row.item}
        language={options.props.language}
        status={reasoningSummaryStatus(row.item, options.props.state)}
        motionActive={row.item.key === options.motionFocus?.itemKey}
        onVisibleContentChange={options.onVisibleContentChange}
      />
    );
  }
  const showPendingDeliveryFeedback = row.item.optimistic && shouldShowPendingMessageDeliveryFeedback(row.item, options.showThinking);
  return (
    <>
      <ThreadItemView
        item={row.item}
        language={options.props.language}
        isLatest={!options.insideWork && row.item.key === options.items[options.items.length - 1]?.key && !options.showThinking}
        animateEntrance={options.enteringItemIds.has(row.item.key)}
        showAssistantActions={!options.insideWork && itemRole(row.item) === 'assistant' && !options.showThinking}
        isLatestUser={row.item.key === options.lastUserKey}
        motionActive={row.item.key === options.motionFocus?.itemKey}
        onEdit={options.props.onEditUserItem}
        onRetry={options.props.onRetryItem}
        onOpenResource={options.props.onOpenResource}
        onLoadResourcePreview={options.props.onLoadResourcePreview}
        onVisibleContentChange={options.onVisibleContentChange}
        responseAnnotations={options.responseAnnotationsByItemId.get(row.item.itemId) ?? emptyResponseAnnotations}
        onAddResponseAnnotation={options.props.onAddResponseAnnotation}
        onUpdateResponseAnnotation={options.props.onUpdateResponseAnnotation}
        onRemoveResponseAnnotation={options.props.onRemoveResponseAnnotation}
        onOpenSideChat={options.props.onOpenSideChat}
      />
      {showPendingDeliveryFeedback ? (
        <MessageDeliveryOutcomeFeedback item={row.item} stateError={options.props.state.error} language={options.props.language} onReturnToComposer={options.props.onRetryItem ? () => options.props.onRetryItem?.(row.item) : undefined} />
      ) : null}
    </>
  );
}

function TranscriptActiveStatus(props: { language: SessionUiLanguage; kind: 'starting' | 'thinking' }): ReactNode {
  return (
    <p className="session-transcript-thinking" data-motion-active="true" role="status" aria-live="polite">
      <span className="session-thinking-pulse" aria-hidden="true" />
      {props.kind === 'starting' ? (props.language === 'zh-CN' ? '正在启动处理' : 'Starting processing') : props.language === 'zh-CN' ? '正在思考' : 'Thinking'}
    </p>
  );
}

function MessageDeliveryOutcomeFeedback(props: { item: NativeSessionItemBuffer; stateError: NativeSessionError | null; language: SessionUiLanguage; onReturnToComposer?: () => void }): ReactNode {
  const zh = props.language === 'zh-CN';
  const deliveryError = nativeSessionErrorFrom(props.item.payload.deliveryError) ?? (props.stateError?.code === 'ZEUS_NATIVE_ACCEPTANCE_HYDRATION_PENDING' ? props.stateError : null);
  const unconfirmed = props.item.status === 'unconfirmed' || props.item.status === 'paused';
  const failed = props.item.status === 'failed';
  const hydrationPending = deliveryError?.code === 'ZEUS_NATIVE_ACCEPTANCE_HYDRATION_PENDING';
  const deliveryFailed = failed || Boolean(deliveryError && !hydrationPending);
  // 正常投递过程不形成独立提示，只保留失败、结果不确定和持久记录确认。
  if (!deliveryFailed && !unconfirmed && !hydrationPending) return null;
  const reason = deliveryError ? messageDeliveryFailureReason(deliveryError, zh) : null;
  const title = deliveryFailed ? (zh ? '消息发送失败' : 'Message send failed') : unconfirmed ? (zh ? '发送结果待确认' : 'Send outcome unconfirmed') : zh ? '消息已接收，正在确认记录' : 'Message accepted; confirming its record';
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
      data-state={deliveryFailed ? 'failed' : unconfirmed ? 'unconfirmed' : 'pending'}
      role={deliveryFailed || unconfirmed ? 'alert' : 'status'}
      aria-live={deliveryFailed || unconfirmed ? 'assertive' : 'polite'}
    >
      <span className="session-thinking-pulse" aria-hidden="true" />
      <span className="session-message-delivery-copy">
        <span className="session-message-delivery-summary">
          <strong>{title}</strong>
          {reason ? <small>{reason}</small> : null}
        </span>
        {guidance ? <small className="session-message-delivery-guidance">{guidance}</small> : null}
        {deliveryError && reason !== deliveryError.message ? (
          <details>
            <summary>{zh ? '技术详情' : 'Technical details'}</summary>
            <code>{[deliveryError.code, deliveryError.message].filter(Boolean).join(': ')}</code>
          </details>
        ) : null}
      </span>
      {failed && props.onReturnToComposer ? (
        <button type="button" onClick={props.onReturnToComposer}>
          {zh ? '修改后重发' : 'Edit and resend'}
        </button>
      ) : null}
    </section>
  );
}

function shouldShowPendingMessageDeliveryFeedback(item: NativeSessionItemBuffer, showActiveStatus: boolean): boolean {
  if (item.status === 'failed' || item.status === 'unconfirmed') return true;
  if (item.status === 'queued') return false;
  if (item.status === 'paused') return item.payload.pausedReason === 'recovery_required';
  return !showActiveStatus;
}

function isOptimisticMessageAwaitingReply(item: NativeSessionItemBuffer): boolean {
  if (!item.optimistic || itemRole(item) !== 'user' || item.status === 'failed' || item.status === 'unconfirmed') return false;
  if (item.status !== 'paused') return true;
  const reason = item.payload.pausedReason;
  // 只有会自动恢复的暂停态继续为即将到来的回复保留空间；需要用户处理或结果待确认时撤销空白区。
  return reason === undefined || reason === 'conflict_preparing' || reason === 'transport_unavailable';
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
  const openingUserRowKeyByTurn = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== 'item' || itemRole(row.item) !== 'user' || openingUserRowKeyByTurn.has(row.item.turnId)) continue;
    openingUserRowKeyByTurn.set(row.item.turnId, row.key);
  }
  const activeTurnOpeningUserRowKey = activeTurnId ? openingUserRowKeyByTurn.get(activeTurnId) : undefined;
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
    if (activeTurnId && !activeTurnOpeningUserRowKey && firstLiveTurnRowKey === row.key) {
      projected.push({ kind: 'turn_work', key: `turn-work-live:${activeTurnId}`, turnId: activeTurnId, rows: liveTurnRows });
    }
    if (liveTurnRowKeys.has(row.key)) continue;
    const turnId = transcriptRowTurnId(row);
    const finalWorkRows = turnId ? workRowsByFinalTurn.get(turnId) : undefined;
    const openingUserRowKey = turnId ? openingUserRowKeyByTurn.get(turnId) : undefined;
    if (turnId && finalWorkRows && !openingUserRowKey && firstWorkRowKeyByFinalTurn.get(turnId) === row.key && !emittedFinalWorkTurns.has(turnId)) {
      projected.push({ kind: 'turn_work', key: `turn-work-final:${turnId}`, turnId, rows: finalWorkRows });
      emittedFinalWorkTurns.add(turnId);
    }
    if (finalWorkRowKeys.has(row.key)) continue;
    projected.push(row);
    // Provider 的过程事件可能先于用户消息落库；展示顺序必须以轮次语义为准，不能把处理过程放到开场消息上方。
    if (activeTurnId && activeTurnOpeningUserRowKey === row.key && liveTurnRows.length > 0) {
      projected.push({ kind: 'turn_work', key: `turn-work-live:${activeTurnId}`, turnId: activeTurnId, rows: liveTurnRows });
    }
    if (turnId && finalWorkRows && openingUserRowKey === row.key && !emittedFinalWorkTurns.has(turnId)) {
      projected.push({ kind: 'turn_work', key: `turn-work-final:${turnId}`, turnId, rows: finalWorkRows });
      emittedFinalWorkTurns.add(turnId);
    }
  }
  return projected;
}

function isLiveTurnTimelineRow(row: TranscriptRow): boolean {
  if (row.kind === 'answered_request' || row.kind === 'activity') return true;
  // 计划是需要独立审核的产物，不属于仍在展开的过程正文。
  return row.item.type !== 'plan' && !isFinalAnswerItem(row.item) && !isAssistantDeliverableItem(row.item);
}

function isTurnProcessRow(row: TranscriptRow): boolean {
  if (row.kind === 'answered_request') return false;
  if (row.kind === 'activity') return true;
  // 计划和明确交付资源属于最终产物，必须独立展示，不能折叠进“已处理”过程。
  if (row.item.type === 'plan' || isAssistantDeliverableItem(row.item)) return false;
  return itemRole(row.item) !== 'user' && !isFinalAnswerItem(row.item);
}

function transcriptRowTurnId(row: TranscriptRow): string | null {
  if (row.kind === 'answered_request') return row.request.turnId;
  return row.kind === 'item' ? row.item.turnId : (row.items[0]?.turnId ?? null);
}

function transcriptTurnRowTurnId(row: TranscriptTurnRow): string | null {
  return row.kind === 'turn_work' ? row.turnId : transcriptRowTurnId(row);
}

function firstVisibleTranscriptWindowRow(container: HTMLElement): HTMLElement | null {
  const containerRect = container.getBoundingClientRect();
  for (const row of container.querySelectorAll<HTMLElement>('.session-transcript-window-row[data-transcript-row-key]')) {
    const rowRect = row.getBoundingClientRect();
    if (rowRect.bottom >= containerRect.top && rowRect.top <= containerRect.bottom) return row;
  }
  return null;
}

function transcriptWindowRow(container: HTMLElement, rowKey: string): HTMLElement | null {
  for (const row of container.querySelectorAll<HTMLElement>('.session-transcript-window-row[data-transcript-row-key]')) {
    if (row.dataset.transcriptRowKey === rowKey) return row;
  }
  return null;
}

function transcriptRowContainsItemKey(row: TranscriptRow, itemKey: string | undefined): boolean {
  if (!itemKey || row.kind === 'answered_request') return false;
  return row.kind === 'item' ? row.item.key === itemKey : row.items.some((item) => item.key === itemKey);
}

export function isFinalAnswerItem(item: NativeSessionItemBuffer): boolean {
  const providerPhase = typeof item.payload.phase === 'string' ? item.payload.phase : item.phase;
  return itemRole(item) === 'assistant' && (providerPhase === 'final_answer' || providerPhase === 'finalAnswer');
}

const MAX_GROUPED_COMMAND_ACTIVITY = 32;

export function projectTranscriptRows(items: readonly NativeSessionItemBuffer[], answeredRequests: readonly NativePendingRequest[] = [], activeTurnId: string | null = null): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let activityTurnId: string | null = null;
  const activityByCategory = new Map<SessionActivityCategory, NativeSessionItemBuffer[]>();
  const activityCategoryOrder: SessionActivityCategory[] = [];
  const currentReasoningItemKey = latestCurrentReasoningItemKey(items, activeTurnId);
  const currentActivityItemKey = latestCurrentActivityItemKey(items, activeTurnId);
  const flushCategory = (category: SessionActivityCategory): void => {
    if (!activityTurnId) return;
    const groupedItems = activityByCategory.get(category);
    if (!groupedItems || groupedItems.length === 0) return;
    rows.push({
      kind: 'activity',
      key: `activity:${activityTurnId}:${category}:${groupedItems[0]!.key}`,
      items: groupedItems,
      category,
      motionActive: groupedItems.some((item) => item.key === currentActivityItemKey),
    });
    activityByCategory.delete(category);
    const categoryIndex = activityCategoryOrder.indexOf(category);
    if (categoryIndex >= 0) activityCategoryOrder.splice(categoryIndex, 1);
  };
  const flushActivity = (): void => {
    for (const category of [...activityCategoryOrder]) flushCategory(category);
    activityTurnId = null;
    activityByCategory.clear();
    activityCategoryOrder.length = 0;
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
    // 多智能体协调事件统一进入右侧智能体面板，不在主会话重复暴露协议载荷。
    if (isSubagentCoordinationItem(item)) continue;
    if (normalizeItemType(item.type) === 'reasoning') {
      // 思考摘要是当前工作状态，不是会话历史正文。每个摘要仍会截断前一批命令，
      // 但只有活动轮次最新一条可见。它代表同一个轮次的实时状态，因此使用轮次级身份，
      // Provider 更换摘要条目时沿用 DOM 节点，让文字与位置更新保持连续。
      flushActivity();
      if (item.key === currentReasoningItemKey) rows.push({ kind: 'item', key: `current-reasoning:${item.turnId}`, item });
      continue;
    }
    if (!isOperationalActivityItem(item)) {
      flushActivity();
      rows.push({ kind: 'item', key: transcriptItemRenderKey(item), item });
      continue;
    }
    // 两条思考摘要之间属于同一工作阶段，但折叠摘要按类别分组；命令、工具、文件变更和上下文整理
    // 各自聚合，展开后仍保留每个类别内的原始明细，避免把不同语义压成一个混合数量。
    const category = activityCategory(item);
    if (category !== 'commands' && !isMergeableToolActivity(item)) {
      // 上下文整理和 Provider 技术事件保留独立摘要，但仍带有明确的分类身份。
      flushActivity();
      activityTurnId = item.turnId;
      activityByCategory.set(category, [item]);
      activityCategoryOrder.push(category);
      flushActivity();
      continue;
    }
    if (activityTurnId && activityTurnId !== item.turnId) flushActivity();
    activityTurnId ??= item.turnId;
    let groupedItems = activityByCategory.get(category);
    if (!groupedItems) {
      groupedItems = [];
      activityByCategory.set(category, groupedItems);
      activityCategoryOrder.push(category);
    }
    if (category === 'commands') {
      if (!canJoinCommandActivity(groupedItems, item)) {
        flushCategory(category);
        groupedItems = [item];
        activityByCategory.set(category, groupedItems);
        activityCategoryOrder.push(category);
      } else {
        groupedItems.push(item);
      }
      if (item.status === 'failed' || groupedItems.length >= MAX_GROUPED_COMMAND_ACTIVITY || !isGroupableCommandSource(item)) flushCategory(category);
      continue;
    }
    if (!canJoinToolActivity(groupedItems, item)) {
      flushCategory(category);
      groupedItems = [item];
      activityByCategory.set(category, groupedItems);
      activityCategoryOrder.push(category);
    } else {
      groupedItems.push(item);
    }
    if (item.status === 'failed' || groupedItems.length >= MAX_GROUPED_TOOL_ACTIVITY) flushCategory(category);
  }
  flushActivity();
  return rows;
}

function latestCurrentReasoningItemKey(items: readonly NativeSessionItemBuffer[], activeTurnId: string | null): string | null {
  if (!activeTurnId || items.some((item) => item.turnId === activeTurnId && isFinalAnswerItem(item))) return null;
  return [...items].reverse().find((item) => item.turnId === activeTurnId && normalizeItemType(item.type) === 'reasoning' && item.status !== 'failed' && item.status !== 'interrupted')?.key ?? null;
}

function latestCurrentActivityItemKey(items: readonly NativeSessionItemBuffer[], activeTurnId: string | null): string | null {
  if (!activeTurnId) return null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.turnId === activeTurnId && isOperationalActivityItem(item) && item.status !== 'completed' && item.status !== 'failed') return item.key;
  }
  return null;
}

function canJoinCommandActivity(activity: readonly NativeSessionItemBuffer[], item: NativeSessionItemBuffer): boolean {
  if (activity.length === 0) return true;
  if (activity.length >= MAX_GROUPED_COMMAND_ACTIVITY || activity[0]!.turnId !== item.turnId) return false;
  if (!isGroupableCommandSource(item) || activity.some((candidate) => !isCommandActivityItem(candidate) || !isGroupableCommandSource(candidate) || candidate.status === 'failed')) return false;
  const hasRunningCommand = activity.some((candidate) => candidate.status !== 'completed');
  return !hasRunningCommand || (isExploringCommand(item) && activity.every(isExploringCommand));
}

const MAX_GROUPED_TOOL_ACTIVITY = 32;

function canJoinToolActivity(activity: readonly NativeSessionItemBuffer[], item: NativeSessionItemBuffer): boolean {
  if (activity.length === 0) return true;
  if (activity.length >= MAX_GROUPED_TOOL_ACTIVITY || activity[0]!.turnId !== item.turnId) return false;
  if (!isMergeableToolActivity(item) || activity.some((candidate) => !isMergeableToolActivity(candidate) || candidate.status === 'failed')) return false;
  return true;
}

function isMergeableToolActivity(item: NativeSessionItemBuffer): boolean {
  const type = normalizeItemType(item.type);
  // 上下文整理有独立摘要口径，Provider 事件属于技术事件，均不与普通工具合并计数。
  return isOperationalActivityItem(item) && !isCommandActivityItem(item) && type !== 'contextcompaction' && type !== 'providerevent';
}

function isCommandActivityItem(item: NativeSessionItemBuffer): boolean {
  return ['commandexecution', 'command'].includes(normalizeItemType(item.type));
}

function isGroupableCommandSource(item: NativeSessionItemBuffer): boolean {
  const source = typeof item.payload.source === 'string' ? normalizeItemType(item.payload.source) : '';
  return source !== 'usershell' && source !== 'unifiedexecinteraction';
}

function isExploringCommand(item: NativeSessionItemBuffer): boolean {
  if (!Array.isArray(item.payload.commandActions) || item.payload.commandActions.length === 0) return false;
  return item.payload.commandActions.every((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const rawType = (value as Record<string, unknown>).type;
    const type = typeof rawType === 'string' ? normalizeItemType(rawType) : '';
    return type === 'read' || type === 'listfiles' || type === 'search';
  });
}

function lastVisibleItemKeyByTurn(rows: readonly TranscriptRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (row.kind === 'answered_request') continue;
    const item = row.kind === 'item' ? row.item : row.items.at(-1);
    if (item) result[item.turnId] = item.key;
  }
  return result;
}

export function isSubagentCoordinationItem(item: Pick<NativeSessionItemBuffer, 'type' | 'payload'>): boolean {
  const rawType = typeof item.payload.type === 'string' ? item.payload.type : item.type;
  const type = rawType.toLowerCase().replaceAll(/[^a-z]/gu, '');
  return type === 'collabagenttoolcall' || type === 'subagentactivity';
}

function transcriptItemRenderKey(item: NativeSessionItemBuffer): string {
  // 同一轮可以有多条思考摘要；每条都必须保留独立且稳定的 React 身份，
  // 否则完成态折叠时会因重复 key 遗留活动态 DOM，形成看似重复的处理过程。
  if (normalizeItemType(item.type) === 'reasoning') return `reasoning-summary:${encodeURIComponent(item.turnId)}:${encodeURIComponent(item.itemId)}`;
  const clientUserMessageId = itemRole(item) === 'user' ? (item.clientUserMessageId ?? item.durableClientUserMessageId) : null;
  // 用户消息的可见身份来自客户端消息 id；Provider 技术条目接管时不能替换整个消息节点。
  return clientUserMessageId ? `user-message:${encodeURIComponent(clientUserMessageId)}` : item.key;
}

export function isVisibleTranscriptItem(item: NativeSessionItemBuffer): boolean {
  if (isSubagentCoordinationItem(item)) return false;
  if (typeof item.payload.requestAnswerId === 'string') return false;
  if (itemRole(item) !== 'commentary') return true;
  return transcriptItemText(item).trim().length > 0;
}

function isUnacceptedQueuedUserItem(item: NativeSessionItemBuffer, state: NativeSessionState, queuedClientUserMessageIds: ReadonlySet<string>): boolean {
  if (!item.optimistic || itemRole(item) !== 'user' || item.payload.delivery !== 'queue') return false;
  const clientUserMessageId = item.clientUserMessageId ?? item.durableClientUserMessageId;
  if (clientUserMessageId && queuedClientUserMessageIds.has(clientUserMessageId)) return true;
  return item.turnId.startsWith('pending:') && Boolean(state.activeTurnId && item.turnId !== state.activeTurnId);
}

type SessionMotionFocusKind = 'thinking' | 'reasoning' | 'activity' | 'plan' | 'image' | 'streaming';

interface ActiveSessionMotionFocus {
  kind: SessionMotionFocusKind;
  itemKey?: string;
}

type SessionMotionFocus = ActiveSessionMotionFocus | null;

const nonRunningMotionStatuses = new Set(['completed', 'failed', 'interrupted', 'waiting', 'pending', 'queued', 'paused', 'unconfirmed']);
const userBlockingConversationStates = new Set(['waiting_approval', 'waiting_user_input', 'interrupt_confirm']);

function resolveSessionMotionFocus(state: NativeSessionState, items: readonly NativeSessionItemBuffer[], showThinking: boolean): SessionMotionFocus {
  if (!state.activeTurnId || userBlockingConversationStates.has(state.conversationState)) return showThinking ? { kind: 'thinking' } : null;
  const activeItems = items.filter((item) => item.turnId === state.activeTurnId && !nonRunningMotionStatuses.has(item.status.toLocaleLowerCase()));

  // 最终回答已经开始时，它是离用户结果最近的活动，优先接管仍未终止的过程条目。
  const finalAnswer = [...activeItems].reverse().find(isFinalAnswerItem);
  if (finalAnswer) return { kind: 'streaming', itemKey: finalAnswer.key };

  for (let index = activeItems.length - 1; index >= 0; index -= 1) {
    const item = activeItems[index]!;
    const kind = sessionMotionKind(item);
    if (kind) return { kind, itemKey: item.key };
  }
  return showThinking ? { kind: 'thinking' } : null;
}

function sessionMotionKind(item: NativeSessionItemBuffer): Exclude<SessionMotionFocusKind, 'thinking'> | null {
  const type = normalizeItemType(item.type);
  if (isOperationalActivityItem(item)) return 'activity';
  if (type === 'plan') return 'plan';
  if (type === 'reasoning') return 'reasoning';
  const role = itemRole(item);
  if (role === 'image') return 'image';
  if (role === 'assistant' || role === 'commentary') return 'streaming';
  return null;
}

export function shouldShowTranscriptThinking(state: NativeSessionState, items: readonly NativeSessionItemBuffer[] = Object.values(state.items)): boolean {
  if (state.conversationState !== 'starting_turn' && state.conversationState !== 'active_prework' && state.conversationState !== 'active_final_answer') return false;
  if (state.conversationState === 'starting_turn' || !state.activeTurnId) return true;
  return !items.some((item) => item.turnId === state.activeTurnId && itemProvidesCurrentVisibleFeedback(item, state));
}

function itemProvidesCurrentVisibleFeedback(item: NativeSessionItemBuffer, state: NativeSessionState): boolean {
  // 最新可读思考摘要在活动轮次中已经使用转圈图标表达持续处理，此时不再叠加第二行“正在思考”。
  if (normalizeItemType(item.type) === 'reasoning' && reasoningSummaryStatus(item, state) === 'active' && transcriptItemText(item).trim().length > 0) return true;
  if (item.status === 'completed' || item.status === 'failed' || item.status === 'interrupted') return false;
  if (itemRole(item) === 'user') return false;
  if (isOperationalActivityItem(item)) return true;
  if (itemRole(item) === 'assistant') return true;
  return transcriptItemText(item).trim().length > 0;
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

function metrics(element: HTMLElement) {
  return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
}

function scrollToLatest(container: Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>, marker?: Pick<HTMLElement, 'scrollIntoView'> | null): void {
  // 先让底部锚点参与布局，唤醒 content-visibility 跳过的历史高度，再做无动画定位。
  marker?.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' });
  // 自动跟随必须即时定位，避免程序滚动事件被误判为用户主动阅读历史。
  container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
}

function normalizeItemType(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_\-/]+/gu, '');
}
