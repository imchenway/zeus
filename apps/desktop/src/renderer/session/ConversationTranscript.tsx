import { Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { activityCategory, isActiveSessionTurn, isLiveActivityItem, isOperationalActivityItem, type SessionActivityCategory, SessionActivityGroup, SessionTurnDuration, SessionTurnProcessDisclosure } from './SessionActivity.js';
import { itemRole, type SessionUiLanguage, ThreadItemView, transcriptItemText } from './ThreadItemView.js';
import { PlanSummary } from './PlanSummary.js';
import type {
  ConversationResource,
  ConversationResourcePreview,
  NativeConversationContentV2Page,
  NativeConversationToolResultPage,
  NativePendingRequest,
  NativeQueueSnapshot,
  NativeSessionError,
  NativeSessionItemBuffer,
  NativeSessionState,
  NativeTurnFailureSnapshot,
  TurnChangeSet,
  TurnChangeSetOperationResult,
} from './sessionTypes.js';
import { isAssistantDeliverableItem } from './sessionTypes.js';
import type { ConversationFileLocation, ConversationOpenTarget, ConversationResponseAnnotation, ConversationResponseTextAnchor } from '@zeus/shared';
import { useThreadScrollController } from './useThreadScrollController.js';
import { TurnChangeCard } from './TurnChanges.js';
import { reasoningSummaryStatus, SessionReasoningSummary } from './SessionReasoningSummary.js';
import { AnsweredRequestHistory, isAnsweredUserInputRequest } from './AnsweredRequestHistory.js';
import { useNewItemMotionIds } from '../ui/useNewItemMotion.js';
import { captureTranscriptViewportAnchor, compensateTranscriptViewportAnchor, type TranscriptViewportAnchor, useTranscriptViewportVirtualizer } from './transcriptViewportVirtualizer.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';

export interface ConversationTranscriptProps {
  state: NativeSessionState;
  language: SessionUiLanguage;
  historyOnly?: boolean;
  /** 从历史入口打开后持续补齐已持久化计划；首次续聊不能让旧计划从时间线消失。 */
  projectPersistedPlans?: boolean;
  onEditUserItem?: (item: NativeSessionItemBuffer, content: string) => void | Promise<void>;
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

function turnDetailPaging(snapshot: NativeSessionState['snapshot'], turnId: string) {
  const process = snapshot?.v2Paging?.processByTurn[turnId];
  // v0.3.46 之前已经留在 Renderer 内存中的分页对象没有 historyByTurn。
  // 升级后第一次打开历史会话必须把它视为空映射，而不是在旧快照上崩溃。
  const history = snapshot?.v2Paging?.historyByTurn?.[turnId];
  if (!process && !history) return undefined;
  return {
    loading: Boolean(process?.loading || history?.loading),
    error: process?.error ?? history?.error ?? null,
    loaded: Boolean(process?.loaded || history?.loaded),
    hasMore: Boolean(process?.hasMore || history?.hasMore),
  };
}

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
  const historyPrependAnchorRef = useRef<(TranscriptViewportAnchor & { frozenCursor: string }) | null>(null);
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
  const activeTurnId = props.historyOnly ? null : props.state.activeTurnId;
  const queuedSubmissions = useMemo(() => visibleQueuedSubmissions(props.state.queue), [props.state.queue]);
  const queuedClientUserMessageIds = useMemo(() => new Set(queuedSubmissions.map((submission) => submission.clientUserMessageId).filter((value): value is string => Boolean(value))), [queuedSubmissions]);
  const persistedItems = useMemo(
    () =>
      props.state.itemOrder
        .map((key) => props.state.items[key])
        .filter(
          (entry): entry is NativeSessionItemBuffer =>
            Boolean(entry) && (!props.historyOnly || !entry.optimistic) && isVisibleTranscriptItem(entry) && isFormalPlanTranscriptItem(entry, props.state) && !isUnacceptedQueuedUserItem(entry, queuedClientUserMessageIds),
        ),
    [props.historyOnly, props.state.activeTurnId, props.state.itemOrder, props.state.items, props.state.planImplementationRequests, queuedClientUserMessageIds],
  );
  const queuedSubmissionItems = useMemo(() => projectQueuedSubmissionItems(props.state, queuedSubmissions, persistedItems), [persistedItems, props.state.conversationId, props.state.providerThreadId, queuedSubmissions]);
  const projectedItems = useMemo(() => {
    // 历史暂停 submission 与新 Provider 正文来自不同投影入口，但必须共享同一条持久时间线。
    // 直接 append 会把数小时前的任务推送卡放到刚发送的消息之后，造成用户气泡“跳到最上面”。
    const durableItems = [...persistedItems, ...queuedSubmissionItems].sort((left, right) => transcriptTimelineAt(left).localeCompare(transcriptTimelineAt(right)) || left.key.localeCompare(right.key));
    return props.projectPersistedPlans ? projectPersistedTurnPlans(props.state, durableItems) : durableItems;
  }, [
    persistedItems,
    props.projectPersistedPlans,
    props.state.conversationId,
    props.state.planImplementationRequests,
    props.state.providerThreadId,
    props.state.snapshot?.snapshotV2,
    props.state.terminalTurnIds,
    props.state.turnsByProviderId,
    queuedSubmissionItems,
  ]);
  const collapsedErrorItems = useMemo(() => collapseRepeatedErrorItems(projectedItems), [projectedItems]);
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
  const transcriptRows = useMemo(() => projectTranscriptRows(items, answeredRequests, activeTurnId, props.historyOnly), [activeTurnId, answeredRequests, items, props.historyOnly]);
  const turnRows = useMemo(() => projectTranscriptTurnRows(transcriptRows, activeTurnId, props.state.terminalTurnIds), [activeTurnId, props.state.terminalTurnIds, transcriptRows]);
  const turnRowKeys = useMemo(() => turnRows.map((row) => row.key), [turnRows]);
  const turnRowsByKey = useMemo(() => new Map(turnRows.map((row) => [row.key, row])), [turnRows]);
  const activeTurnRowKeys = useMemo(() => new Set(turnRows.filter((row) => activeTurnId && transcriptTurnRowTurnId(row) === activeTurnId).map((row) => row.key)), [activeTurnId, turnRows]);
  const pinnedRowKeys = useMemo(() => {
    const pinned = new Set([...activeTurnRowKeys, ...expandedRowKeys]);
    if (focusedRowKey) pinned.add(focusedRowKey);
    if (historyAnchorRowKey) pinned.add(historyAnchorRowKey);
    return pinned;
  }, [activeTurnRowKeys, expandedRowKeys, focusedRowKey, historyAnchorRowKey]);
  const isFollowingLatest = useCallback(() => scrollController.getState().mode !== 'static', [scrollController]);
  const viewportVirtualizer = useTranscriptViewportVirtualizer({
    scopeKey: props.state.conversationId,
    rowKeys: turnRowKeys,
    pinnedRowKeys,
    containerRef,
    isFollowingLatest,
    suspendAutomaticAnchor: historyAnchorRowKey !== null,
  });
  const projectedTurnWorkIds = useMemo(() => new Set(turnRows.filter((row): row is TranscriptTurnWorkRow => row.kind === 'turn_work').map((row) => row.turnId)), [turnRows]);
  const lastItemKeyByTurn = useMemo(() => lastVisibleItemKeyByTurn(transcriptRows), [transcriptRows]);
  const orphanFailedTurns = useMemo(() => {
    const visibleTurnIds = new Set(transcriptRows.map(transcriptRowTurnId).filter((turnId): turnId is string => Boolean(turnId)));
    return Object.values(props.state.turnsByProviderId)
      .filter((turn) => turn.status === 'failed' && turn.error && !visibleTurnIds.has(turn.providerTurnId ?? ''))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }, [props.state.turnsByProviderId, transcriptRows]);
  const showActiveStatus = !props.historyOnly && shouldShowTranscriptThinking(props.state, items);
  const motionFocus = props.historyOnly ? null : resolveSessionMotionFocus(props.state, transcriptItems, showActiveStatus);
  const activeStatusKind = props.state.conversationState === 'starting_turn' ? 'starting' : 'thinking';
  const creatingSession = props.creationStatus?.state === 'creating';
  const realTurnStarted = Boolean(activeTurnId);
  // 创建期只保留一个主进度：真实轮次建立前显示连接，建立后由轮次状态或真实过程内容接管。
  const showCreationStatus = Boolean(props.creationStatus) && !(creatingSession && realTurnStarted);
  const showStandaloneActiveStatus = showActiveStatus && !(creatingSession && !realTurnStarted);
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
    const anchor = { frozenCursor, ...captureTranscriptViewportAnchor(container) };
    historyPrependAnchorRef.current = anchor;
    setHistoryAnchorRowKey(anchor.rowKey);
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
    compensateTranscriptViewportAnchor(container, anchor);
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
      previousTurnIdRef.current = activeTurnId;
      return;
    }
    if (activeTurnId && previousTurnIdRef.current !== activeTurnId) {
      const effect = scrollController.onTurnStarted(metrics(container), Date.now());
      if (effect.type === 'scroll_to_bottom') {
        scrollToLatest(container, latestContentMarkerRef.current);
        setReturnToLatestVisible(false);
      }
    }
    previousTurnIdRef.current = activeTurnId;
  }, [activeTurnId, historyHydrated, latestSubmittedMessageId, scrollController]);

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
      const expansionKey = turnProcessExpansionKey(row.turnId);
      if (!turn) {
        const processPaging = turnDetailPaging(props.state.snapshot, row.turnId);
        return (
          <SessionTurnProcessDisclosure
            language={props.language}
            loading={Boolean(processPaging?.loading)}
            error={processPaging?.error}
            open={expandedRowKeys.has(expansionKey)}
            onOpenChange={(open) => setTranscriptRowExpanded(expansionKey, open)}
            onOpen={async () => {
              await renderProps.onLoadTurnProcess?.(row.turnId);
              await renderProps.onLoadTurnArtifacts?.(row.turnId);
            }}
          >
            {row.rows.map((child) => (
              <Fragment key={child.key}>{renderTranscriptRow(child, transcriptRowRenderOptions(renderProps, items, false, motionFocus, lastUserKey, true, enteringItemIds, maintainLatestPosition, responseAnnotationsByItemId))}</Fragment>
            ))}
            {processPaging?.loaded && processPaging.hasMore && renderProps.onLoadTurnProcess ? (
              <V2AutoPageSentinel loading={processPaging.loading} error={processPaging.error} kind="process" language={props.language} onLoad={() => renderProps.onLoadTurnProcess?.(row.turnId)} />
            ) : null}
          </SessionTurnProcessDisclosure>
        );
      }
      const containsLastItem = row.rows.some((child) => transcriptRowContainsItemKey(child, lastItemKeyByTurn[row.turnId]));
      const active = isActiveSessionTurn(turn);
      const v2PagingKey = turn.providerTurnId ?? turn.id;
      const processPaging = turnDetailPaging(props.state.snapshot, v2PagingKey);
      const process = row.rows.map((child) => {
        const content = renderTranscriptRow(
          child,
          transcriptRowRenderOptions(renderProps, items, showActiveStatus && activeTurnId === row.turnId, motionFocus, lastUserKey, true, enteringItemIds, maintainLatestPosition, responseAnnotationsByItemId),
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
              loading={Boolean(processPaging?.loading)}
              error={processPaging?.error}
              open={expandedRowKeys.has(expansionKey)}
              onOpenChange={(open) => setTranscriptRowExpanded(expansionKey, open)}
              onOpen={async () => {
                await renderProps.onLoadTurnProcess?.(row.turnId);
                await renderProps.onLoadTurnArtifacts?.(row.turnId);
              }}
            >
              {process}
              {processPaging?.loaded && processPaging.hasMore && renderProps.onLoadTurnProcess ? (
                <V2AutoPageSentinel loading={processPaging.loading} error={processPaging.error} kind="process" language={props.language} onLoad={() => renderProps.onLoadTurnProcess?.(row.turnId)} />
              ) : null}
            </SessionTurnProcessDisclosure>
          )}
          {!active && containsLastItem ? (
            <>
              {renderTurnArtifacts(row.turnId, renderProps, lastItemKeyByTurn[row.turnId])}
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
    const expansionKey = turnProcessExpansionKey(v2PagingKey);
    const v2ProcessPaging = turnDetailPaging(props.state.snapshot, v2PagingKey);
    const v2Turn = props.state.snapshot?.snapshotV2
      ? [...props.state.snapshot.snapshotV2.recentClosedTurns, ...(props.state.snapshot.snapshotV2.activeTurn ? [props.state.snapshot.snapshotV2.activeTurn] : [])].find(
          (candidate) => candidate.id === turn?.id || (turn?.providerTurnId && candidate.providerTurnId === turn.providerTurnId),
        )
      : undefined;
    // 入口只能来自可见过程事实。缺少 turn summary 或仅有历史视图会隐藏的 reasoning，
    // 都不能凭最终回答臆造一个展开后为空的“查看处理过程”。
    const historicalProcessAvailable = Boolean(v2Turn?.process.available);
    const showV2DeferredDetails = Boolean(closesVisibleTurn && !projectedTurnWorkIds.has(lastRowItem.turnId) && historicalProcessAvailable && (!turn || !isActiveSessionTurn(turn)));
    return (
      <>
        {renderTranscriptRow(row, transcriptRowRenderOptions(renderProps, items, showActiveStatus, motionFocus, lastUserKey, false, enteringItemIds, maintainLatestPosition, responseAnnotationsByItemId))}
        {showV2DeferredDetails ? (
          <SessionTurnProcessDisclosure
            language={props.language}
            labelKind={historicalProcessAvailable ? 'process' : 'details'}
            loading={Boolean(v2ProcessPaging?.loading)}
            error={v2ProcessPaging?.error}
            open={expandedRowKeys.has(expansionKey)}
            onOpenChange={(open) => setTranscriptRowExpanded(expansionKey, open)}
            onOpen={async () => {
              await renderProps.onLoadTurnProcess?.(lastRowItem.turnId);
              await renderProps.onLoadTurnArtifacts?.(lastRowItem.turnId);
            }}
          >
            {null}
          </SessionTurnProcessDisclosure>
        ) : null}
        {closesVisibleTurn ? renderTurnArtifacts(lastRowItem.turnId, renderProps, lastRowItem.key) : null}
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
          <V2HistoryPageSentinel state={props.state} onLoadEarlier={renderProps.onLoadEarlierHistory ? loadEarlierHistoryWithAnchor : undefined} />
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
            <p className="session-transcript-empty">
              {props.historyOnly
                ? props.language === 'zh-CN'
                  ? '这条历史会话没有可显示的消息。'
                  : 'This historical conversation has no visible messages.'
                : props.language === 'zh-CN'
                  ? '发送第一条消息后，真实 app-server 对话会显示在这里。'
                  : 'Send the first message to begin the real app-server transcript.'}
            </p>
          ) : null}
          {orphanFailedTurns.map((turn) => (
            <TurnFailureCard key={`turn-failure:${turn.providerTurnId ?? turn.id}`} failure={turn.error!} language={props.language} />
          ))}
          {showCreationStatus && props.creationStatus ? <SessionCreationNotice status={props.creationStatus} language={props.language} /> : null}
          {showStandaloneActiveStatus ? <TranscriptActiveStatus language={props.language} kind={activeStatusKind} /> : null}
          <span ref={latestContentMarkerRef} className="session-latest-content-marker" aria-hidden="true" />
        </section>
        <V2HistoryPageStatus state={props.state} language={props.language} />
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

function V2HistoryPageSentinel(props: { state: NativeSessionState; onLoadEarlier?: () => void | Promise<void> }) {
  const paging = props.state.snapshot?.v2Paging?.history;
  const sentinelRef = useRef<HTMLSpanElement | null>(null);
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
      { root: sentinel.closest('.session-transcript'), rootMargin: '180px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [cursor, paging?.error, paging?.hasMore, paging?.loading, props.onLoadEarlier]);
  if (!props.state.snapshot?.snapshotV2 || !paging || (!paging.hasMore && !paging.error)) return null;
  return <span ref={sentinelRef} className="session-v2-history-sentinel" aria-hidden="true" />;
}

function V2HistoryPageStatus(props: { state: NativeSessionState; language: SessionUiLanguage }) {
  const paging = props.state.snapshot?.v2Paging?.history;
  if (!props.state.snapshot?.snapshotV2 || !paging || (!paging.loading && !paging.error)) return null;
  const failed = Boolean(paging.error);
  return (
    <section className="session-v2-history-status" data-state={failed ? 'error' : 'loading'} role={failed ? 'alert' : 'status'} aria-live={failed ? undefined : 'polite'}>
      {paging.error ? <VisibleApplicationError error={paging.error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} /> : props.language === 'zh-CN' ? '正在读取更早消息…' : 'Loading earlier messages…'}
    </section>
  );
}

function V2AutoPageSentinel(props: { loading: boolean; error: string | null | undefined; kind: 'process'; language: SessionUiLanguage; onLoad: () => void | Promise<void> }) {
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
      { root: sentinel.closest('.session-transcript'), rootMargin: '240px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [props.error, props.loading, props.onLoad]);
  const loadingLabel = props.language === 'zh-CN' ? '正在补齐处理过程…' : 'Loading process…';
  return (
    <span ref={sentinelRef} className="session-v2-auto-page" role={props.error ? 'alert' : props.loading ? 'status' : undefined}>
      {props.loading ? loadingLabel : null}
      {props.error ? <VisibleApplicationError error={props.error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} /> : null}
    </span>
  );
}

function SessionCreationNotice(props: { status: SessionCreationStatus; language: SessionUiLanguage }) {
  if (props.status.state !== 'creating') {
    return (
      <section className={`session-creation-status is-${props.status.state}`} role="alert" aria-live="assertive">
        <VisibleApplicationError error={props.status.error ?? props.status.message} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
        {props.status.onRetry ? (
          <button type="button" onClick={() => void props.status.onRetry?.()}>
            {props.status.retryLabel ?? (props.language === 'zh-CN' ? '重试' : 'Retry')}
          </button>
        ) : null}
      </section>
    );
  }
  return (
    <section className="session-creation-status is-creating" role="status" aria-live="polite">
      {sessionConnectionSymbol}
      <span className="session-creation-status-copy">
        <strong>{props.status.message}</strong>
      </span>
    </section>
  );
}

function TurnFailureCard(props: { failure: NativeTurnFailureSnapshot; language: SessionUiLanguage }) {
  const zh = props.language === 'zh-CN';
  const warning = props.failure.code === 'ZEUS_PI_MODEL_REQUEST_FAILED';
  return (
    <article
      className="session-turn-failure"
      data-severity={warning ? 'warning' : 'error'}
      role={warning ? 'status' : 'alert'}
      aria-label={warning ? (zh ? '模型请求警告' : 'Model request warning') : zh ? '会话失败原因' : 'Conversation failure reason'}
    >
      <VisibleApplicationError error={props.failure} language={zh ? 'zh-CN' : 'en'} />
    </article>
  );
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
        onOpenResource={options.props.onOpenResource}
        onLoadResourcePreview={options.props.onLoadResourcePreview}
        onLoadToolResult={options.props.onLoadV2ToolResult}
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
        onOpenResource={options.props.onOpenResource}
        onLoadResourcePreview={options.props.onLoadResourcePreview}
        onVisibleContentChange={options.onVisibleContentChange}
        responseAnnotations={options.responseAnnotationsByItemId.get(row.item.itemId) ?? emptyResponseAnnotations}
        onAddResponseAnnotation={options.props.onAddResponseAnnotation}
        onUpdateResponseAnnotation={options.props.onUpdateResponseAnnotation}
        onRemoveResponseAnnotation={options.props.onRemoveResponseAnnotation}
        onOpenSideChat={options.props.onOpenSideChat}
      />
      {showPendingDeliveryFeedback ? <MessageDeliveryOutcomeFeedback item={row.item} stateError={options.props.state.error} language={options.props.language} /> : null}
    </>
  );
}

function TranscriptActiveStatus(props: { language: SessionUiLanguage; kind: 'starting' | 'thinking' }): ReactNode {
  return (
    <p className="session-transcript-thinking" data-motion-active="true" role="status" aria-live="polite">
      <span className="session-thinking-pulse" aria-hidden="true" />
      <span className="session-current-status-text">{props.kind === 'starting' ? (props.language === 'zh-CN' ? '正在启动处理' : 'Starting processing') : props.language === 'zh-CN' ? '正在思考' : 'Thinking'}</span>
    </p>
  );
}

function MessageDeliveryOutcomeFeedback(props: { item: NativeSessionItemBuffer; stateError: NativeSessionError | null; language: SessionUiLanguage }): ReactNode {
  const deliveryError = nativeSessionErrorFrom(props.item.payload.deliveryError) ?? nativeSessionErrorFrom(props.item.payload.error) ?? props.stateError;
  const unconfirmed = props.item.status === 'unconfirmed' || props.item.status === 'paused';
  const failed = props.item.status === 'failed';
  if (!deliveryError || (!failed && !unconfirmed)) return null;
  const feedbackState = failed ? 'failed' : 'unconfirmed';

  return (
    <section className="session-message-delivery-feedback" data-state={feedbackState} role="alert" aria-live="assertive">
      <VisibleApplicationError error={deliveryError} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
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

function renderTurnArtifacts(turnId: string, props: ConversationTranscriptProps, lastItemKey: string | undefined): ReactNode {
  if (!lastItemKey) return null;
  const turn = props.state.turnsByProviderId[turnId];
  if (!turn) return null;
  const changeSet = props.state.changeSetsByProviderId[turnId];
  return (
    <>
      {changeSet && changeSet.state !== 'capturing' && (changeSet.fileCount > 0 || changeSet.state === 'conflicted') ? (
        <TurnChangeCard changeSet={changeSet} language={props.language} onReview={props.onReviewTurnChanges} onOperate={props.onOperateTurnChangeSet} />
      ) : null}
      {turn.status === 'failed' && turn.error ? <TurnFailureCard failure={turn.error} language={props.language} /> : null}
    </>
  );
}

export function projectTranscriptTurnRows(rows: readonly TranscriptRow[], activeTurnId: string | null = null, terminalTurnIds: Readonly<Record<string, 'completed' | 'interrupted' | 'failed'>> = {}): TranscriptTurnRow[] {
  const finalAnswerTurnIds = new Set(rows.flatMap((row) => (row.kind === 'item' && isFinalAnswerItem(row.item) ? [row.item.turnId] : [])));
  // 权威活动轮次优先于任何提前或误分类的 final item；运行中永远使用展开时间线，不能提前出现完成态入口。
  const collapsibleTurnIds = new Set([...finalAnswerTurnIds, ...Object.keys(terminalTurnIds)].filter((turnId) => turnId !== activeTurnId));
  const openingUserRowKeyByTurn = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== 'item' || itemRole(row.item) !== 'user' || openingUserRowKeyByTurn.has(row.item.turnId)) continue;
    openingUserRowKeyByTurn.set(row.item.turnId, row.key);
  }
  const activeTurnOpeningUserRowKey = activeTurnId ? openingUserRowKeyByTurn.get(activeTurnId) : undefined;
  const liveTurnRows = activeTurnId ? rows.filter((row) => row.key !== activeTurnOpeningUserRowKey && transcriptRowTurnId(row) === activeTurnId && isLiveTurnTimelineRow(row)) : [];
  const liveTurnRowKeys = new Set(liveTurnRows.map((row) => row.key));
  const firstLiveTurnRowKey = liveTurnRows[0]?.key;
  const workRowsByFinalTurn = new Map<string, TranscriptRow[]>();
  const firstWorkRowKeyByFinalTurn = new Map<string, string>();
  const finalWorkRowKeys = new Set<string>();
  for (const row of rows) {
    const turnId = transcriptRowTurnId(row);
    if (!turnId || !collapsibleTurnIds.has(turnId) || !isTurnProcessRow(row)) continue;
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
  if (row.kind === 'answered_request') return true;
  if (row.kind === 'activity') return true;
  // 计划和明确交付资源属于最终产物，必须独立展示，不能折叠进“已处理”过程。
  if (row.item.type === 'plan' || isAssistantDeliverableItem(row.item)) return false;
  return itemRole(row.item) !== 'user' && !isFinalAnswerItem(row.item);
}

function transcriptRowTurnId(row: TranscriptRow): string | null {
  if (row.kind === 'answered_request') return row.request.turnId;
  return row.kind === 'item' ? row.item.turnId : (row.items[0]?.turnId ?? null);
}

function turnProcessExpansionKey(turnId: string): string {
  return `turn-process:${turnId}`;
}

function transcriptTurnRowTurnId(row: TranscriptTurnRow): string | null {
  return row.kind === 'turn_work' ? row.turnId : transcriptRowTurnId(row);
}

function transcriptRowContainsItemKey(row: TranscriptRow, itemKey: string | undefined): boolean {
  if (!itemKey || row.kind === 'answered_request') return false;
  return row.kind === 'item' ? row.item.key === itemKey : row.items.some((item) => item.key === itemKey);
}

export function isFinalAnswerItem(item: NativeSessionItemBuffer): boolean {
  const providerPhase = typeof item.payload.phase === 'string' ? item.payload.phase : item.phase;
  return itemRole(item) === 'assistant' && (providerPhase === 'final_answer' || providerPhase === 'finalAnswer');
}

export function projectTranscriptRows(items: readonly NativeSessionItemBuffer[], answeredRequests: readonly NativePendingRequest[] = [], activeTurnId: string | null = null, historyOnly = false): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const effectiveActiveTurnId = historyOnly ? null : activeTurnId && items.some((item) => item.turnId === activeTurnId) ? activeTurnId : latestLiveTurnId(items);
  const latestReasoningByTurn = latestReasoningItemsByTurn(items);
  const currentActivityItemKey = latestCurrentActivityItemKey(items, effectiveActiveTurnId);
  const activitiesByTurn = new Map<string, NativeSessionItemBuffer[]>();
  for (const item of items) {
    if (isSubagentCoordinationItem(item) || !isOperationalActivityItem(item)) continue;
    const turnActivities = activitiesByTurn.get(item.turnId) ?? [];
    turnActivities.push(item);
    activitiesByTurn.set(item.turnId, turnActivities);
  }
  const emittedActivityTurns = new Set<string>();
  const timeline: Array<{ kind: 'item'; item: NativeSessionItemBuffer } | { kind: 'answered_request'; request: NativePendingRequest }> = items.map((item) => ({ kind: 'item', item }));
  for (const request of [...answeredRequests].sort((left, right) => (left.resolvedAt ?? left.createdAt).localeCompare(right.resolvedAt ?? right.createdAt))) {
    // 缺少轮次身份的旧记录不能靠时间猜测归属，也不能重新污染主会话时间线。
    if (!request.turnId) continue;
    const requestTimelineAt = request.resolvedAt ?? request.createdAt;
    // 已回答询问按答案提交时间落位；普通条目使用首次进入时间线的稳定时间，不能用流式更新后的时间重排。
    const insertionIndex = timeline.findIndex((entry) => entry.kind === 'item' && (entry.item.timelineAt ?? entry.item.updatedAt ?? '') >= requestTimelineAt);
    timeline.splice(insertionIndex < 0 ? timeline.length : insertionIndex, 0, { kind: 'answered_request', request });
  }
  const lastTimelineIndexByTurn = new Map<string, number>();
  timeline.forEach((entry, index) => {
    const turnId = entry.kind === 'item' ? entry.item.turnId : entry.request.turnId;
    if (turnId) lastTimelineIndexByTurn.set(turnId, index);
  });
  for (let index = 0; index < timeline.length; index += 1) {
    const entry = timeline[index]!;
    const turnId = entry.kind === 'item' ? entry.item.turnId : entry.request.turnId;
    if (entry.kind === 'answered_request') {
      rows.push({ kind: 'answered_request', key: `answered-request:${entry.request.id}`, request: entry.request });
    } else {
      const item = entry.item;
      // 多智能体协调事件统一进入右侧智能体面板，不在主会话重复暴露协议载荷。
      if (!isSubagentCoordinationItem(item) && normalizeItemType(item.type) !== 'reasoning') {
        if (!isOperationalActivityItem(item)) {
          rows.push({ kind: 'item', key: transcriptItemRenderKey(item), item });
        } else if (!emittedActivityTurns.has(item.turnId)) {
          emittedActivityTurns.add(item.turnId);
          const groupedItems = activitiesByTurn.get(item.turnId) ?? [item];
          const categories = new Set(groupedItems.map(activityCategory));
          rows.push({
            kind: 'activity',
            key: `activity:${item.turnId}`,
            items: groupedItems,
            category: categories.size === 1 ? activityCategory(groupedItems[0]!) : 'mixed',
            motionActive: groupedItems.some((candidate) => candidate.key === currentActivityItemKey),
          });
        }
      }
    }
    if (turnId && lastTimelineIndexByTurn.get(turnId) === index) {
      const latestReasoning = latestReasoningByTurn.get(turnId);
      if (latestReasoning) rows.push({ kind: 'item', key: `current-reasoning:${turnId}`, item: latestReasoning });
    }
  }
  return rows;
}

function latestReasoningItemsByTurn(items: readonly NativeSessionItemBuffer[]): ReadonlyMap<string, NativeSessionItemBuffer> {
  const result = new Map<string, NativeSessionItemBuffer>();
  for (const item of items) {
    if (normalizeItemType(item.type) !== 'reasoning' || item.status === 'failed' || item.status === 'interrupted') continue;
    result.set(item.turnId, item);
  }
  return result;
}

function latestCurrentActivityItemKey(items: readonly NativeSessionItemBuffer[], activeTurnId: string | null): string | null {
  if (!activeTurnId) return null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.turnId === activeTurnId && isOperationalActivityItem(item) && item.status !== 'completed' && item.status !== 'failed') return item.key;
  }
  return null;
}

function latestLiveTurnId(items: readonly NativeSessionItemBuffer[]): string | null {
  return [...items].reverse().find((item) => item.status !== 'completed' && item.status !== 'failed' && item.status !== 'interrupted')?.turnId ?? null;
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

function isFormalPlanTranscriptItem(item: NativeSessionItemBuffer, state: NativeSessionState): boolean {
  if (normalizeItemType(item.type) !== 'plan') return true;
  if (item.payload.formalPlan === true) return true;
  return state.planImplementationRequests.some((request) => request.planItemId === item.localItemId || request.planItemId === item.itemId || request.planItemId === item.providerItemId);
}

/** V2 把 PLAN 持久化在轮次快照而不是模型正文中；历史视图必须把它还原为该轮的正式产物。 */
function projectPersistedTurnPlans(state: NativeSessionState, items: readonly NativeSessionItemBuffer[]): NativeSessionItemBuffer[] {
  const turnsWithVisiblePlan = new Set(items.filter((item) => normalizeItemType(item.type) === 'plan').map((item) => item.turnId));
  const requestByTurn = new Map(state.planImplementationRequests.map((request) => [request.turnId, request]));
  const planItems = Object.values(state.turnsByProviderId).flatMap((turn) => {
    const turnId = turn.providerTurnId ?? turn.id;
    const formalPlan = requestByTurn.has(turn.id) || requestByTurn.has(turnId);
    if (!turn.plan || !formalPlan || turnsWithVisiblePlan.has(turnId)) return [];
    const request = requestByTurn.get(turnId) ?? requestByTurn.get(turn.id);
    const itemId = request?.planItemId || `${turn.id}:plan`;
    const updatedAt = turn.completedAt ?? turn.updatedAt ?? turn.createdAt;
    const explanation = turn.plan.explanation?.trim() ?? '';
    const steps = turn.plan.steps.map((step, index) => `${index + 1}. ${step.step.trim()}`).filter((step) => step.length > 3);
    const text = [explanation, steps.join('\n')].filter(Boolean).join('\n\n');
    if (!text) return [];
    return [
      {
        key: `turn-plan:${encodeURIComponent(state.conversationId ?? '')}:${encodeURIComponent(turnId)}`,
        conversationId: state.conversationId ?? '',
        threadId: state.providerThreadId ?? 'unbound-thread',
        turnId,
        itemId,
        localItemId: itemId,
        type: 'plan',
        status: state.terminalTurnIds[turnId] ? 'completed' : turn.status,
        phase: 'final_answer',
        text,
        payload: { phase: 'final_answer', formalPlan: true, plan: turn.plan },
        resources: [],
        optimistic: false,
        timelineAt: updatedAt,
        updatedAt,
      } satisfies NativeSessionItemBuffer,
    ];
  });
  if (planItems.length === 0) return [...items];
  return [...items, ...planItems].sort((left, right) => transcriptTimelineAt(left).localeCompare(transcriptTimelineAt(right)) || left.key.localeCompare(right.key));
}

function transcriptTimelineAt(item: NativeSessionItemBuffer): string {
  return item.timelineAt ?? item.updatedAt ?? '';
}

function isUnacceptedQueuedUserItem(item: NativeSessionItemBuffer, queuedClientUserMessageIds: ReadonlySet<string>): boolean {
  if (!item.optimistic || itemRole(item) !== 'user' || item.payload.delivery !== 'queue') return false;
  const clientUserMessageId = item.clientUserMessageId ?? item.durableClientUserMessageId;
  // Provider 的 active turn 会早于 userMessage/模型历史投影到达。此时不能因为 pending turn id
  // 与 Provider turn id 不同就隐藏本地气泡；只有队列已经用同一客户端身份画出替身时才去重。
  return Boolean(clientUserMessageId && queuedClientUserMessageIds.has(clientUserMessageId));
}

function visibleQueuedSubmissions(queue: NativeQueueSnapshot | null) {
  return [...(queue?.submissions ?? [])]
    .filter((submission) => (submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'steering' || submission.status === 'paused') && !submission.providerTurnId)
    .sort((left, right) => left.position - right.position || (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id));
}

/**
 * Provider 轮次建立前就暂停的提交同样是已落库历史。它们不能只存在于队列状态里，
 * 否则冷开会话会过滤掉乐观消息，并把用户已经发送的内容渲染成整页空白。
 */
function projectQueuedSubmissionItems(state: NativeSessionState, submissions: ReturnType<typeof visibleQueuedSubmissions>, persistedItems: readonly NativeSessionItemBuffer[]): NativeSessionItemBuffer[] {
  const visibleSubmissionIds = new Set(persistedItems.flatMap((item) => [item.localItemId, item.itemId]).filter((value): value is string => Boolean(value)));
  const visibleClientMessageIds = new Set(
    persistedItems
      .filter((item) => itemRole(item) === 'user')
      .flatMap((item) => [item.clientUserMessageId, item.durableClientUserMessageId])
      .filter((value): value is string => Boolean(value)),
  );
  return submissions.flatMap((submission) => {
    if (visibleSubmissionIds.has(submission.id) || visibleSubmissionIds.has(`queued-submission:${submission.id}`)) return [];
    if (submission.clientUserMessageId && visibleClientMessageIds.has(submission.clientUserMessageId)) return [];
    const text = submission.composerDraft?.trim() || submission.content.trim();
    const hasVisibleResources = Boolean(submission.attachments?.length || submission.browserComments?.length || submission.conversationContext);
    if (!text && !hasVisibleResources) return [];
    const timestamp = submission.createdAt ?? submission.updatedAt ?? '';
    const deliveryError = submission.error
      ? {
          code: submission.error.code,
          message: submission.error.message,
          recoveryRequired: submission.error.recoveryRequired,
          retryable: false,
        }
      : null;
    return [
      {
        key: `queued-submission:${encodeURIComponent(submission.id)}`,
        conversationId: state.conversationId ?? submission.conversationId ?? '',
        threadId: state.providerThreadId ?? '',
        turnId: `pending:${submission.id}`,
        itemId: `queued-submission:${submission.id}`,
        localItemId: submission.id,
        type: 'userMessage',
        status: submission.status,
        phase: 'user',
        text,
        payload: {
          role: 'user',
          content: text,
          delivery: submission.delivery ?? 'queue',
          pausedReason: submission.pausedReason,
          ...(submission.attachments?.length ? { attachments: submission.attachments } : {}),
          ...(submission.browserComments?.length ? { browserComments: submission.browserComments } : {}),
          ...(submission.conversationContext ? { conversationContext: submission.conversationContext } : {}),
          ...(deliveryError ? { deliveryError } : {}),
        },
        resources: [],
        optimistic: true,
        ...(submission.clientUserMessageId ? { clientUserMessageId: submission.clientUserMessageId, durableClientUserMessageId: submission.clientUserMessageId } : {}),
        ...(timestamp ? { timelineAt: timestamp, updatedAt: submission.updatedAt ?? timestamp } : {}),
      },
    ];
  });
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
  if (state.conversationState === 'starting_turn') return true;
  const effectiveActiveTurnId = state.activeTurnId && items.some((item) => item.turnId === state.activeTurnId) ? state.activeTurnId : latestLiveTurnId(items);
  if (!effectiveActiveTurnId) return true;
  return !items.some((item) => item.turnId === effectiveActiveTurnId && itemProvidesCurrentModelStatus(item, state));
}

function itemProvidesCurrentModelStatus(item: NativeSessionItemBuffer, state: NativeSessionState): boolean {
  // 只有“模型当前在做什么”的思考摘要或已经开始的最终回答可以替代底部状态行；
  // 命令、文件、网页和技能只是过程明细，不能让进行中状态消失。
  if (normalizeItemType(item.type) === 'reasoning' && reasoningSummaryStatus(item, state) === 'active' && transcriptItemText(item).trim().length > 0) return true;
  if (item.status === 'completed' || item.status === 'failed' || item.status === 'interrupted') return false;
  return isFinalAnswerItem(item);
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
