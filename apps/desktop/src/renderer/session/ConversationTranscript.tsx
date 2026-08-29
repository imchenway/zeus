import { Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { activityCategory, isActiveSessionTurn, isLiveActivityItem, isOperationalActivityItem, type SessionActivityCategory, SessionActivityGroup, SessionTurnDuration, SessionTurnProcessDisclosure } from './SessionActivity.js';
import { itemRole, type SessionUiLanguage, ThreadItemView, transcriptItemText } from './ThreadItemView.js';
import { PlanSummary } from './PlanSummary.js';
import type {
  ConversationResource,
  ConversationResourcePreview,
  NativeConversationToolResultPage,
  NativePendingRequest,
  NativeQueuedSubmission,
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
import { useApplicationErrorDialog, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { isImageResource } from './ConversationResources.js';
import { canSteerActiveTurn } from './ConversationComposer.js';
import type { McpAppToolCall, McpAppToolResult } from './McpAppFrame.js';

export interface ConversationTranscriptProps {
  state: NativeSessionState;
  language: SessionUiLanguage;
  historyOnly?: boolean;
  /** 子线程等只读投影没有主会话快照时，仍可明确声明时间线已完成水合。 */
  transcriptHydrated?: boolean;
  /** 从历史入口打开后持续补齐已持久化计划；首次续聊不能让旧计划从时间线消失。 */
  projectPersistedPlans?: boolean;
  onEditUserItem?: (item: NativeSessionItemBuffer, content: string) => void | Promise<void>;
  openPlanItemKey?: string | null;
  onOpenPlan?: (item: NativeSessionItemBuffer) => void;
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
  onCallMcpAppTool?: (input: McpAppToolCall) => Promise<McpAppToolResult>;
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
  onLoadV2Content?: (handle: string) => Promise<void>;
  onLoadV2ToolResult?: (handle: string, offset?: number) => Promise<NativeConversationToolResultPage>;
  onRecoverQueue?: () => void | Promise<void>;
  onInterrupt?: (turnId: string) => void | Promise<void>;
  onRetryQueuedSubmission?: (submissionId: string) => void | Promise<void>;
  onCancelQueuedSubmission?: (submissionId: string) => void | Promise<void>;
  onSendQueuedNow?: (submissionId: string) => void | Promise<void>;
}

export interface SessionCreationStatus {
  state: 'creating' | 'retrying' | 'failed' | 'warning';
  message: string;
  retryAttempt?: number;
  maxRetries?: number;
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

function containsMarkdownImage(item: NativeSessionItemBuffer): boolean {
  return /!\[[^\]]*\]\([^)]+\)/u.test(transcriptItemText(item));
}

function imageAttachmentDescriptors(item: NativeSessionItemBuffer): Array<{ name: string; taskPushAttachmentKey: string | null }> {
  const content = typeof item.payload.content === 'object' && item.payload.content !== null && !Array.isArray(item.payload.content) ? (item.payload.content as Record<string, unknown>) : null;
  const sources = [item.payload.attachments, content?.attachments].filter(Array.isArray);
  const descriptors = sources.flatMap((source) =>
    source.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
      const attachment = entry as Record<string, unknown>;
      const name = typeof attachment.name === 'string' ? attachment.name : '';
      const mime = typeof attachment.mime === 'string' ? attachment.mime : typeof attachment.mimeType === 'string' ? attachment.mimeType : '';
      const image = attachment.kind === 'image' || mime.startsWith('image/');
      if (!name || !image) return [];
      return [
        {
          name,
          taskPushAttachmentKey: typeof attachment.taskPushAttachmentKey === 'string' && attachment.taskPushAttachmentKey ? attachment.taskPushAttachmentKey : null,
        },
      ];
    }),
  );
  return [...new Map(descriptors.map((descriptor) => [`${descriptor.taskPushAttachmentKey ?? ''}\u0000${descriptor.name}`, descriptor])).values()];
}

function itemNeedsImageResources(item: NativeSessionItemBuffer): boolean {
  if (containsMarkdownImage(item) && !item.resources.some((resource) => resource.presentation === 'inline' && isImageResource(resource))) return true;
  if (item.optimistic) return false;
  return imageAttachmentDescriptors(item).some(
    (attachment) =>
      !item.resources.some(
        (resource) => resource.kind === 'attachment' && isImageResource(resource) && ((attachment.taskPushAttachmentKey && resource.taskPushAttachmentKey === attachment.taskPushAttachmentKey) || resource.displayName === attachment.name),
      ),
  );
}

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

function turnProcessAvailable(snapshot: NativeSessionState['snapshot'], turnId: string): boolean {
  const v2 = snapshot?.snapshotV2;
  if (!v2) return false;
  const turn = [...v2.recentClosedTurns, ...(v2.activeTurn ? [v2.activeTurn] : [])].find((candidate) => candidate.id === turnId || candidate.providerTurnId === turnId);
  return turn?.process.available ?? false;
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
  const [historyPagingGate, setHistoryPagingGate] = useState<{ conversationId: string | null; positioned: boolean; userIntent: boolean }>({ conversationId: null, positioned: false, userIntent: false });
  const [historyPagingRequestedConversationId, setHistoryPagingRequestedConversationId] = useState<string | null>(null);
  const [historySentinelIntersection, setHistorySentinelIntersection] = useState<{ conversationId: string | null; intersecting: boolean }>({ conversationId: null, intersecting: false });
  const [completedAnnouncement, setCompletedAnnouncement] = useState<{ key: string; text: string } | null>(null);
  const completedAnnouncementTrackerRef = useRef<CompletedItemAnnouncementTracker>({ hydrated: false, lastCompletedKey: null });
  const positionedConversationIdRef = useRef<string | null>(null);
  const trackedUserMessageRef = useRef<{ conversationId: string | null; key: string | null; initialized: boolean }>({ conversationId: null, key: null, initialized: false });
  const awaitingReplyMessageIdsRef = useRef<Set<string>>(new Set());
  const awaitingReplyConversationIdRef = useRef<string | null>(null);
  const automaticResourceLoadAttemptRef = useRef<string | null>(null);
  const [rowExpansionOverrides, setRowExpansionOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [historyAnchorRowKey, setHistoryAnchorRowKey] = useState<string | null>(null);
  const historyPagingArmed = historyPagingGate.conversationId === props.state.conversationId && historyPagingGate.positioned && historyPagingGate.userIntent;
  const historyPagingRequested = historyPagingRequestedConversationId === props.state.conversationId;
  const historySentinelIntersecting = historySentinelIntersection.conversationId === props.state.conversationId && historySentinelIntersection.intersecting;
  const armHistoryPaging = useCallback(() => {
    const conversationId = props.state.conversationId;
    setHistoryPagingGate((current) => {
      if (current.conversationId !== conversationId || !current.positioned || current.userIntent) return current;
      return { ...current, userIntent: true };
    });
  }, [props.state.conversationId]);
  const updateHistorySentinelIntersection = useCallback((intersecting: boolean) => setHistorySentinelIntersection({ conversationId: props.state.conversationId, intersecting }), [props.state.conversationId]);
  const activeTurnId = props.historyOnly ? null : props.state.activeTurnId;
  const queuedSubmissions = useMemo(() => visibleQueuedSubmissions(props.state.queue), [props.state.queue]);
  const queuedClientUserMessageIds = useMemo(() => new Set(queuedSubmissions.map((submission) => submission.clientUserMessageId).filter((value): value is string => Boolean(value))), [queuedSubmissions]);
  const persistedItems = useMemo(
    () =>
      coalesceTranscriptUserMessages(
        props.state.itemOrder
          .map((key) => props.state.items[key])
          .filter(
            (entry): entry is NativeSessionItemBuffer =>
              Boolean(entry) && (!props.historyOnly || !entry.optimistic) && isVisibleTranscriptItem(entry) && isFormalPlanTranscriptItem(entry, props.state) && !isUnacceptedQueuedUserItem(entry, queuedClientUserMessageIds),
          ),
      ),
    [props.historyOnly, props.state.activeTurnId, props.state.itemOrder, props.state.items, props.state.planImplementationRequests, queuedClientUserMessageIds],
  );
  const queuedSubmissionItems = useMemo(() => projectQueuedSubmissionItems(props.state, queuedSubmissions, persistedItems), [persistedItems, props.state.conversationId, props.state.providerThreadId, queuedSubmissions]);
  const projectedItems = useMemo(() => {
    // 历史暂停 submission 与新 Provider 正文来自不同投影入口，但必须共享同一条持久时间线。
    // 直接 append 会把数小时前的任务推送卡放到刚发送的消息之后，造成用户气泡“跳到最上面”。
    const durableItems = coalesceSupersededInterruptedQueuedUserMessages(
      [...persistedItems, ...queuedSubmissionItems].sort((left, right) => transcriptTimelineAt(left).localeCompare(transcriptTimelineAt(right)) || left.key.localeCompare(right.key)),
    );
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
  const historyHydrated = props.transcriptHydrated ?? props.state.snapshot !== null;
  const enteringItemIds = useNewItemMotionIds(
    items.map((item) => item.key),
    220,
    historyHydrated,
  );
  const lastUserKey = [...items].reverse().find((entry) => `${entry.type}`.toLocaleLowerCase().includes('user'))?.key;
  const answeredRequests = useMemo(() => props.state.pendingRequests.filter(isAnsweredUserInputRequest), [props.state.pendingRequests]);
  const transcriptRows = useMemo(() => projectTranscriptRows(items, answeredRequests, activeTurnId, props.historyOnly, props.state.terminalTurnIds), [activeTurnId, answeredRequests, items, props.historyOnly, props.state.terminalTurnIds]);
  const turnRows = useMemo(() => projectTranscriptTurnRows(transcriptRows, activeTurnId, props.state.terminalTurnIds), [activeTurnId, props.state.terminalTurnIds, transcriptRows]);
  const defaultExpandedRowKeys = useMemo(() => defaultExpandedTurnProcessKeys(turnRows, props.state.turnsByProviderId, props.state.terminalTurnIds), [props.state.terminalTurnIds, props.state.turnsByProviderId, turnRows]);
  const activeProcessExpansionKey = useMemo(() => {
    const activeWork = turnRows.find((row): row is TranscriptTurnWorkRow => row.kind === 'turn_work' && row.live);
    return activeWork ? turnProcessExpansionKey(activeWork.key) : null;
  }, [turnRows]);
  const previousActiveProcessExpansionKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const previousKey = previousActiveProcessExpansionKeyRef.current;
    previousActiveProcessExpansionKeyRef.current = activeProcessExpansionKey;
    if (!previousKey || previousKey === activeProcessExpansionKey) return;
    // 正文到达或活动轮次切换时必须回到完成态默认值：处理过程自动收起。
    // 这同时清除运行中用户手动展开/收起留下的覆盖，避免完成态继续沿用旧交互状态。
    setRowExpansionOverrides((current) => {
      if (!current.has(previousKey)) return current;
      const next = new Map(current);
      next.delete(previousKey);
      return next;
    });
  }, [activeProcessExpansionKey]);
  const expandedRowKeys = useMemo(() => {
    const expanded = new Set(defaultExpandedRowKeys);
    for (const [rowKey, open] of rowExpansionOverrides) {
      if (open) expanded.add(rowKey);
      else expanded.delete(rowKey);
    }
    return expanded;
  }, [defaultExpandedRowKeys, rowExpansionOverrides]);
  const activeProcessCollapsed = activeProcessExpansionKey !== null && !expandedRowKeys.has(activeProcessExpansionKey);
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
  const completionAnchorKeyByTurn = useMemo(() => turnArtifactAnchorKeyByTurn(transcriptRows), [transcriptRows]);
  const orphanFailedTurns = useMemo(() => {
    const visibleTurnIds = new Set(transcriptRows.map(transcriptRowTurnId).filter((turnId): turnId is string => Boolean(turnId)));
    return Object.values(props.state.turnsByProviderId)
      .filter((turn) => turn.status === 'failed' && turn.error && !visibleTurnIds.has(turn.providerTurnId ?? ''))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }, [props.state.turnsByProviderId, transcriptRows]);
  const showActiveStatus = !props.historyOnly && shouldShowTranscriptThinking(props.state, items);
  const motionFocus = props.historyOnly ? null : resolveSessionMotionFocus(props.state, transcriptItems, showActiveStatus);
  const activeStatusKind = props.state.conversationState === 'starting_turn' ? 'starting' : 'thinking';
  const creatingSession = props.creationStatus?.state === 'creating' || props.creationStatus?.state === 'retrying';
  const creationFailed = props.creationStatus?.state === 'failed';
  const realTurnStarted = Boolean(activeTurnId);
  // 创建期只保留一个主进度：真实轮次建立前显示连接，建立后由轮次状态或真实过程内容接管。
  const showCreationStatus = Boolean(props.creationStatus) && !(creatingSession && realTurnStarted);
  const showStandaloneActiveStatus = (showActiveStatus || activeProcessCollapsed) && !creationFailed && !(creatingSession && !realTurnStarted);
  const interactionAuthorityMissing = props.state.queue?.state.type === 'paused' && props.state.queue.state.reason === 'interaction_authority_missing' && Boolean(props.state.activeTurnId);
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
    onRetryQueuedSubmission: useStableOptionalCallback(props.onRetryQueuedSubmission),
  };
  const itemNeedingImageResources = useMemo(() => items.find(itemNeedsImageResources) ?? null, [items]);
  const resourcePaging = props.state.snapshot?.v2Paging?.resources;
  useEffect(() => {
    const loadTurnArtifacts = renderProps.onLoadTurnArtifacts;
    // 资源补齐后解除本次尝试锁。若后续权威快照异常丢失展示资源，可再次自愈；
    // 真正失败且状态未变化时仍保留尝试键，避免无界重试。
    if (!itemNeedingImageResources) {
      automaticResourceLoadAttemptRef.current = null;
      return;
    }
    // 渐进水合会先投影可读正文，再发布完整交互快照。若在 hydrating 阶段读取，
    // 连接代次切换会丢弃该页且相同正文不会再触发一次；必须等权威水合完成。
    if (props.state.transportState !== 'ready' || !loadTurnArtifacts || !resourcePaging || resourcePaging.loading) return;
    // 首次调用可能先取得资源页、后取得带 providerItemId 的正文。把资源页代次和
    // Provider item 身份都纳入尝试键，允许第二次只执行内存合并，但仍禁止无界重试。
    const attemptKey = `${props.state.conversationId}:${itemNeedingImageResources.turnId}:${itemNeedingImageResources.providerItemId ?? itemNeedingImageResources.key}:${resourcePaging.loaded}:${resourcePaging.hasMore}:${resourcePaging.nextCursor ?? 'end'}:${resourcePaging.items.length}`;
    if (automaticResourceLoadAttemptRef.current === attemptKey) return;
    automaticResourceLoadAttemptRef.current = attemptKey;
    // Markdown 图片和已持久用户附件都属于正文，不应要求用户先展开“处理过程”
    // 才能取得资源元数据。
    // 失败保留现有占位与手动重试入口，避免 React 重渲染形成无界请求循环。
    void Promise.resolve(loadTurnArtifacts(itemNeedingImageResources.turnId)).catch(() => undefined);
  }, [itemNeedingImageResources, props.state.conversationId, props.state.transportState, renderProps.onLoadTurnArtifacts, resourcePaging]);
  const loadEarlierHistoryWithAnchor = useCallback(async (): Promise<void> => {
    const loadEarlier = renderProps.onLoadEarlierHistory;
    const container = containerRef.current;
    const frozenCursor = props.state.snapshot?.v2Paging?.history.nextCursor;
    if (!loadEarlier || !container || !frozenCursor || historyPrependAnchorRef.current) return;
    const anchor = { frozenCursor, ...captureTranscriptViewportAnchor(container) };
    historyPrependAnchorRef.current = anchor;
    setHistoryPagingRequestedConversationId(props.state.conversationId);
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
  }, [props.state.conversationId, props.state.snapshot?.v2Paging?.history.nextCursor, renderProps.onLoadEarlierHistory]);

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
    setHistoryPagingGate({ conversationId, positioned: true, userIntent: false });
    setHistoryPagingRequestedConversationId(null);
    setHistorySentinelIntersection({ conversationId, intersecting: false });
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
    setRowExpansionOverrides((current) => {
      if (current.get(rowKey) === open) return current;
      const next = new Map(current);
      next.set(rowKey, open);
      return next;
    });
  }, []);

  const renderTranscriptTurnRow = (row: TranscriptTurnRow): ReactNode => {
    if (row.kind === 'answered_request') return <AnsweredRequestHistory request={row.request} language={props.language} />;
    if (row.kind === 'turn_work') {
      const turn = props.state.turnsByProviderId[row.turnId];
      const expansionKey = turnProcessExpansionKey(row.key);
      const containsCompletionAnchor = row.segments.some(
        (segment) =>
          Boolean(segment.summary && transcriptRowContainsItemKey(segment.summary, completionAnchorKeyByTurn[row.turnId])) || segment.rows.some((child) => transcriptRowContainsItemKey(child, completionAnchorKeyByTurn[row.turnId])),
      );
      const renderProcessSegments = (active: boolean): ReactNode =>
        row.segments.map((segment, segmentIndex) => (
          <section className="session-turn-process-stage" data-current={row.live && segmentIndex === row.segments.length - 1 ? true : undefined} key={segment.key}>
            {segment.summary ? (
              <div className="session-turn-stage-summary">
                {renderTranscriptRow(segment.summary, transcriptRowRenderOptions(renderProps, items, false, motionFocus, lastUserKey, true, enteringItemIds, maintainLatestPosition, responseAnnotationsByItemId))}
              </div>
            ) : null}
            {segment.rows.map((child) => {
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
            })}
          </section>
        ));
      if (!turn) {
        const processPaging = turnDetailPaging(props.state.snapshot, row.turnId);
        const hasProcessDetails = row.segments.length > 0 || (row.loadMore && turnProcessAvailable(props.state.snapshot, row.turnId));
        return (
          <>
            {hasProcessDetails ? (
              <SessionTurnProcessDisclosure
                language={props.language}
                loading={Boolean(row.loadMore && processPaging?.loading)}
                error={row.loadMore ? processPaging?.error : null}
                open={expandedRowKeys.has(expansionKey)}
                onOpenChange={(open) => setTranscriptRowExpanded(expansionKey, open)}
                onOpen={async () => {
                  if (!row.loadMore) return;
                  await renderProps.onLoadTurnProcess?.(row.turnId);
                  await renderProps.onLoadTurnArtifacts?.(row.turnId);
                }}
              >
                {renderProcessSegments(false)}
                {row.loadMore && processPaging?.loaded && processPaging.hasMore && renderProps.onLoadTurnProcess ? (
                  <V2AutoPageSentinel loading={processPaging.loading} error={processPaging.error} kind="process" language={props.language} onLoad={() => renderProps.onLoadTurnProcess?.(row.turnId)} />
                ) : null}
              </SessionTurnProcessDisclosure>
            ) : null}
          </>
        );
      }
      const active = isActiveSessionTurn(turn);
      const v2PagingKey = turn.providerTurnId ?? turn.id;
      const processPaging = turnDetailPaging(props.state.snapshot, v2PagingKey);
      const hasProcessDetails = row.segments.length > 0 || (row.loadMore && turnProcessAvailable(props.state.snapshot, v2PagingKey));
      const process = renderProcessSegments(active);
      return (
        <>
          {hasProcessDetails ? (
            <SessionTurnProcessDisclosure
              language={props.language}
              loading={Boolean(row.loadMore && processPaging?.loading)}
              error={row.loadMore ? processPaging?.error : null}
              open={expandedRowKeys.has(expansionKey)}
              onOpenChange={(open) => setTranscriptRowExpanded(expansionKey, open)}
              onOpen={async () => {
                if (!row.loadMore) return;
                await renderProps.onLoadTurnProcess?.(row.turnId);
                await renderProps.onLoadTurnArtifacts?.(row.turnId);
              }}
            >
              {process}
              {row.loadMore && processPaging?.loaded && processPaging.hasMore && renderProps.onLoadTurnProcess ? (
                <V2AutoPageSentinel loading={processPaging.loading} error={processPaging.error} kind="process" language={props.language} onLoad={() => renderProps.onLoadTurnProcess?.(row.turnId)} />
              ) : null}
            </SessionTurnProcessDisclosure>
          ) : null}
          {!active && containsCompletionAnchor ? renderTurnArtifacts(row.turnId, renderProps, completionAnchorKeyByTurn[row.turnId]) : null}
          {!active && containsCompletionAnchor ? <SessionTurnDuration turn={turn} requests={props.state.pendingRequests} language={props.language} /> : null}
        </>
      );
    }
    const rowItems = row.kind === 'item' ? [row.item] : row.items;
    const lastRowItem = rowItems[rowItems.length - 1]!;
    const turn = props.state.turnsByProviderId[lastRowItem.turnId];
    const closesVisibleTurn = completionAnchorKeyByTurn[lastRowItem.turnId] === lastRowItem.key;
    const anchorsTurnArtifacts = closesVisibleTurn;
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
        {anchorsTurnArtifacts ? renderTurnArtifacts(lastRowItem.turnId, renderProps, lastRowItem.key) : null}
        {closesVisibleTurn && turn ? <SessionTurnDuration turn={turn} requests={props.state.pendingRequests} language={props.language} /> : null}
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
          onWheel={(event) => {
            if (event.deltaY < 0) armHistoryPaging();
          }}
          onScroll={(event) => {
            const mode = scrollController.onUserScroll(metrics(event.currentTarget));
            setReturnToLatestVisible(mode.mode === 'static');
            if (mode.mode === 'static') armHistoryPaging();
            viewportVirtualizer.synchronizeViewport(event.currentTarget);
            scheduleLatestContentVisibility();
          }}
        >
          <V2HistoryPageSentinel
            key={props.state.conversationId}
            state={props.state}
            enabled={historyPagingArmed}
            onIntersectionChange={updateHistorySentinelIntersection}
            onLoadEarlier={renderProps.onLoadEarlierHistory ? loadEarlierHistoryWithAnchor : undefined}
          />
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
          {interactionAuthorityMissing && props.state.activeTurnId ? <InteractionAuthorityMissingNotice language={props.language} turnId={props.state.activeTurnId} onInterrupt={props.onInterrupt} /> : null}
          <span ref={latestContentMarkerRef} className="session-latest-content-marker" aria-hidden="true" />
        </section>
        <V2HistoryPageStatus state={props.state} language={props.language} enabled={historyPagingArmed && historyPagingRequested} intersecting={historySentinelIntersecting} />
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

function V2HistoryPageSentinel(props: { state: NativeSessionState; enabled: boolean; onIntersectionChange: (intersecting: boolean) => void; onLoadEarlier?: () => void | Promise<void> }) {
  const paging = props.state.snapshot?.v2Paging?.history;
  const sentinelRef = useRef<HTMLSpanElement | null>(null);
  const requestedCursorRef = useRef<string | null>(null);
  const [intersecting, setIntersecting] = useState(false);
  const cursor = paging?.nextCursor ?? null;
  const visible = Boolean(props.state.snapshot?.snapshotV2 && paging && (paging.hasMore || paging.error));
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    if (typeof IntersectionObserver === 'undefined') {
      setIntersecting(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        setIntersecting(entries.some((entry) => entry.isIntersecting));
      },
      { root: sentinel.closest('.session-transcript'), rootMargin: '0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => props.onIntersectionChange(intersecting), [intersecting, props.onIntersectionChange]);
  useEffect(() => {
    if (!props.enabled || !intersecting || !cursor || !paging?.hasMore || paging.loading || paging.error || !props.onLoadEarlier || requestedCursorRef.current === cursor) return;
    requestedCursorRef.current = cursor;
    void Promise.resolve(props.onLoadEarlier()).catch(() => undefined);
  }, [cursor, intersecting, paging?.error, paging?.hasMore, paging?.loading, props.enabled, props.onLoadEarlier]);
  if (!visible) return null;
  return <span ref={sentinelRef} className="session-v2-history-sentinel" aria-hidden="true" />;
}

function V2HistoryPageStatus(props: { state: NativeSessionState; language: SessionUiLanguage; enabled: boolean; intersecting: boolean }) {
  const paging = props.state.snapshot?.v2Paging?.history;
  if (!props.enabled || !props.intersecting || !props.state.snapshot?.snapshotV2 || !paging || (!paging.loading && !paging.hasMore && !paging.error)) return null;
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
  if (props.status.state !== 'creating' && props.status.state !== 'retrying') {
    return (
      <section className={`session-creation-status is-${props.status.state}`} role="alert" aria-live="assertive">
        <div className="session-creation-status-error">
          <VisibleApplicationError error={props.status.error ?? props.status.message} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
        </div>
        {props.status.onRetry ? (
          <button type="button" onClick={() => void props.status.onRetry?.()}>
            {props.status.retryLabel ?? (props.language === 'zh-CN' ? '重试' : 'Retry')}
          </button>
        ) : null}
      </section>
    );
  }
  const retryingMessage = props.status.state === 'retrying' ? `${props.language === 'zh-CN' ? '正在重试' : 'Retrying'}… ${props.status.retryAttempt ?? 1}/${props.status.maxRetries ?? 5}` : props.status.message;
  return (
    <section className={`session-creation-status is-${props.status.state}`} role="status" aria-live="polite">
      {sessionConnectionSymbol}
      <span className="session-creation-status-copy">
        <strong>{retryingMessage}</strong>
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
  segments: TranscriptTurnProcessSegment[];
  live: boolean;
  loadMore: boolean;
}

export interface TranscriptTurnProcessSegment {
  key: string;
  summary: TranscriptRow | null;
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
    return (
      <TranscriptV2ContentBoundary item={row.item} onLoadContent={options.props.onLoadV2Content}>
        <PlanSummary item={row.item} language={options.props.language} motionActive={row.item.key === options.motionFocus?.itemKey} panelOpen={options.props.openPlanItemKey === row.item.key} onOpenPanel={options.props.onOpenPlan} />
      </TranscriptV2ContentBoundary>
    );
  }
  if (normalizeItemType(row.item.type) === 'reasoning') {
    return (
      <TranscriptV2ContentBoundary item={row.item} onLoadContent={options.props.onLoadV2Content}>
        <SessionReasoningSummary
          item={row.item}
          language={options.props.language}
          status={reasoningSummaryStatus(row.item, options.props.state)}
          motionActive={row.item.key === options.motionFocus?.itemKey}
          onVisibleContentChange={options.onVisibleContentChange}
        />
      </TranscriptV2ContentBoundary>
    );
  }
  const showPendingDeliveryFeedback = row.item.optimistic && shouldShowPendingMessageDeliveryFeedback(row.item, options.showThinking);
  const queuedSubmission = queuedSubmissionForItem(row.item, options.props.state.queue);
  const queuedSubmissionId = queuedSubmission && !queuedSubmission.controlAction && !queuedSubmission.providerTurnId ? queuedSubmission.id : undefined;
  const queuedSteerDisabledReason = queuedSubmissionId && queuedSubmission?.status === 'queued' ? queuedSteerUnavailableReason(options.props.state, queuedSubmission, options.props.language) : undefined;
  return (
    <TranscriptV2ContentBoundary item={row.item} onLoadContent={options.props.onLoadV2Content}>
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
        onLoadResources={options.props.onLoadTurnArtifacts}
        onCallMcpAppTool={options.props.onCallMcpAppTool}
        onVisibleContentChange={options.onVisibleContentChange}
        responseAnnotations={options.responseAnnotationsByItemId.get(row.item.itemId) ?? emptyResponseAnnotations}
        onAddResponseAnnotation={options.props.onAddResponseAnnotation}
        onUpdateResponseAnnotation={options.props.onUpdateResponseAnnotation}
        onRemoveResponseAnnotation={options.props.onRemoveResponseAnnotation}
        onOpenSideChat={options.props.onOpenSideChat}
        queuedSubmissionId={queuedSubmissionId}
        queuedSteerDisabledReason={queuedSteerDisabledReason}
        onSteerQueuedSubmission={queuedSubmission?.status === 'queued' ? options.props.onSendQueuedNow : undefined}
        onDeleteQueuedSubmission={queuedSubmission?.status === 'queued' || queuedSubmission?.status === 'paused' ? options.props.onCancelQueuedSubmission : undefined}
      />
      {showPendingDeliveryFeedback ? (
        <MessageDeliveryOutcomeFeedback
          item={row.item}
          language={options.props.language}
          onRecoverQueue={options.props.onRecoverQueue}
          onRetryQueuedSubmission={options.props.onRetryQueuedSubmission}
          onCancelQueuedSubmission={options.props.onCancelQueuedSubmission}
        />
      ) : null}
    </TranscriptV2ContentBoundary>
  );
}

function TranscriptV2ContentBoundary(props: { item: NativeSessionItemBuffer; onLoadContent?: (handle: string) => Promise<void>; children: ReactNode }): ReactNode {
  const handle = typeof props.item.payload.v2ContentHandle === 'string' && props.item.payload.v2ContentHandle ? props.item.payload.v2ContentHandle : null;
  const truncated = props.item.payload.v2ContentKind === 'model_history' && props.item.payload.v2ContentTruncated === true;
  const canLoad = Boolean(handle && props.onLoadContent);
  const attemptedHandleRef = useRef<string | null>(null);

  useEffect(() => {
    if (!truncated) {
      attemptedHandleRef.current = null;
      return;
    }
    if (!canLoad || !handle || !props.onLoadContent || attemptedHandleRef.current === handle) return;
    attemptedHandleRef.current = handle;
    // 完整正文恢复由 Controller 持续收敛；消息组件不把本地读取失败转嫁成用户操作。
    void props.onLoadContent(handle).catch(() => undefined);
  }, [canLoad, handle, props.onLoadContent, truncated]);

  return props.children;
}

function TranscriptActiveStatus(props: { language: SessionUiLanguage; kind: 'starting' | 'thinking' }): ReactNode {
  return (
    <p className="session-transcript-thinking" data-motion-active="true" role="status" aria-live="polite">
      <span className="session-thinking-pulse" aria-hidden="true" />
      <span className="session-current-status-text">{props.kind === 'starting' ? (props.language === 'zh-CN' ? '正在启动处理' : 'Starting processing') : props.language === 'zh-CN' ? '正在思考' : 'Thinking'}</span>
    </p>
  );
}

function InteractionAuthorityMissingNotice(props: { language: SessionUiLanguage; turnId: string; onInterrupt?: (turnId: string) => void | Promise<void> }): ReactNode {
  const [stopping, setStopping] = useState(false);
  const stop = () => {
    if (!props.onInterrupt || stopping) return;
    setStopping(true);
    void Promise.resolve(props.onInterrupt(props.turnId)).finally(() => setStopping(false));
  };
  return (
    <section className="session-message-delivery-feedback" data-state="unconfirmed" role="alert" aria-live="assertive">
      <span>{props.language === 'zh-CN' ? '当前任务正在等待用户输入，但问题通道未能恢复；这不是仍在思考。' : 'This turn is waiting for user input, but the question channel could not be recovered. It is not still thinking.'}</span>
      <div className="session-message-delivery-actions">
        <button type="button" disabled={!props.onInterrupt || stopping} onClick={stop}>
          {stopping ? (props.language === 'zh-CN' ? '正在停止…' : 'Stopping…') : props.language === 'zh-CN' ? '停止当前任务' : 'Stop current turn'}
        </button>
      </div>
    </section>
  );
}

function MessageDeliveryOutcomeFeedback(props: {
  item: NativeSessionItemBuffer;
  language: SessionUiLanguage;
  onRecoverQueue?: () => void | Promise<void>;
  onRetryQueuedSubmission?: (submissionId: string) => void | Promise<void>;
  onCancelQueuedSubmission?: (submissionId: string) => void | Promise<void>;
}): ReactNode {
  const [busyAction, setBusyAction] = useState<'recover' | 'retry' | 'cancel' | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  useApplicationErrorDialog(actionError, { language: props.language === 'zh-CN' ? 'zh-CN' : 'en' });
  const pausedReason = props.item.payload.pausedReason;
  if (pausedReason === 'provider_stop_pending') {
    return (
      <section className="session-message-delivery-feedback" data-state="provider-stop-pending" role="status" aria-live="polite">
        {props.language === 'zh-CN' ? '正在确认上次运行已停止，确认后将自动继续' : 'Confirming the previous run has stopped. This message will continue automatically afterward.'}
      </section>
    );
  }
  const deliveryError = nativeSessionErrorFrom(props.item.payload.deliveryError) ?? nativeSessionErrorFrom(props.item.payload.error);
  const unconfirmed = props.item.status === 'unconfirmed' || props.item.status === 'paused';
  const failed = props.item.status === 'failed';
  if (!deliveryError || (!failed && !unconfirmed)) return null;
  const feedbackState = failed ? 'failed' : 'unconfirmed';

  const providerStopRecoveryFailed = pausedReason === 'recovery_required' && deliveryError.code === 'ZEUS_PROVIDER_STOP_RECOVERY_REQUIRED';
  const recoveredUnsent = pausedReason === 'recovered_unsent' && deliveryError.code === 'ZEUS_RECOVERED_UNSENT_CONFIRMATION_REQUIRED';
  const modelWindowUnavailable = deliveryError.code === 'ZEUS_CONTEXT_MODEL_WINDOW_UNAVAILABLE';
  const submissionId = props.item.localItemId || (typeof props.item.payload.submissionId === 'string' ? props.item.payload.submissionId : null);
  const runAction = (action: 'recover' | 'retry' | 'cancel', operation: (() => void | Promise<void>) | undefined) => {
    if (!operation || busyAction) return;
    setActionError(null);
    setBusyAction(action);
    void Promise.resolve()
      .then(operation)
      .catch(setActionError)
      .finally(() => setBusyAction(null));
  };

  return (
    <section className="session-message-delivery-feedback" data-state={feedbackState} role="alert" aria-live="assertive">
      {providerStopRecoveryFailed ? (
        <span>{props.language === 'zh-CN' ? '无法确认上次运行已安全停止。' : 'The previous run could not be confirmed as safely stopped.'}</span>
      ) : recoveredUnsent ? (
        <span>{props.language === 'zh-CN' ? '这条消息尚未发送，请逐条重试或取消。' : 'This message was not sent. Retry or cancel each recovered message individually.'}</span>
      ) : modelWindowUnavailable ? (
        <span>{props.language === 'zh-CN' ? 'Codex 模型能力尚未就绪，这条消息未发送。' : 'Codex model capabilities are not ready. This message was not sent.'}</span>
      ) : (
        <VisibleApplicationError error={deliveryError} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
      )}
      {providerStopRecoveryFailed ? (
        <div className="session-message-delivery-actions">
          <button type="button" disabled={busyAction !== null} onClick={() => runAction('recover', props.onRecoverQueue)}>
            {props.language === 'zh-CN' ? '重新核对' : 'Check again'}
          </button>
          <button type="button" disabled={busyAction !== null || !submissionId} onClick={() => runAction('cancel', submissionId && props.onCancelQueuedSubmission ? () => props.onCancelQueuedSubmission?.(submissionId) : undefined)}>
            {props.language === 'zh-CN' ? '取消消息' : 'Cancel message'}
          </button>
        </div>
      ) : recoveredUnsent || modelWindowUnavailable ? (
        <div className="session-message-delivery-actions">
          <button type="button" disabled={busyAction !== null || !submissionId} onClick={() => runAction('retry', submissionId && props.onRetryQueuedSubmission ? () => props.onRetryQueuedSubmission?.(submissionId) : undefined)}>
            {props.language === 'zh-CN' ? '重试' : 'Retry'}
          </button>
          {recoveredUnsent ? (
            <button type="button" disabled={busyAction !== null || !submissionId} onClick={() => runAction('cancel', submissionId && props.onCancelQueuedSubmission ? () => props.onCancelQueuedSubmission?.(submissionId) : undefined)}>
              {props.language === 'zh-CN' ? '取消消息' : 'Cancel message'}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function shouldShowPendingMessageDeliveryFeedback(item: NativeSessionItemBuffer, showActiveStatus: boolean): boolean {
  if (item.status === 'failed' || item.status === 'unconfirmed') return true;
  if (item.status === 'queued') return false;
  if (item.status === 'paused') return item.payload.pausedReason === 'recovery_required' || item.payload.pausedReason === 'provider_stop_pending' || item.payload.pausedReason === 'recovered_unsent';
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
  const orderedRows = projectDeliverablesAfterFinalAnswer(rows);
  const finalAnswerTurnIds = new Set(orderedRows.flatMap((row) => (row.kind === 'item' && isFinalAnswerItem(row.item) ? [row.item.turnId] : [])));
  // 权威活动轮次优先于任何提前或误分类的 final item；阶段摘要只负责切分单轮过程内部的内容，
  // 不能再生成多个顶层折叠入口。final 正文一旦到达，该轮过程立即按完成态自动收起。
  const projectedTurnIds = new Set([...finalAnswerTurnIds, ...Object.keys(terminalTurnIds), ...(activeTurnId ? [activeTurnId] : [])]);
  const openingUserRowKeyByTurn = new Map<string, string>();
  for (const row of orderedRows) {
    if (row.kind !== 'item' || itemRole(row.item) !== 'user' || openingUserRowKeyByTurn.has(row.item.turnId)) continue;
    openingUserRowKeyByTurn.set(row.item.turnId, row.key);
  }

  const processRowsByTurn = new Map<string, TranscriptRow[]>();
  for (const row of orderedRows) {
    const turnId = transcriptRowTurnId(row);
    if (!turnId || !projectedTurnIds.has(turnId) || !isTurnProcessRow(row)) continue;
    const workRows = processRowsByTurn.get(turnId) ?? [];
    workRows.push(row);
    processRowsByTurn.set(turnId, workRows);
  }

  const workRowByTurn = new Map<string, TranscriptTurnWorkRow>();
  const processRowKeys = new Set<string>();
  for (const [turnId, processRows] of processRowsByTurn) {
    const segments = segmentTurnProcessRows(turnId, processRows);
    workRowByTurn.set(turnId, {
      kind: 'turn_work',
      key: `turn-work:${encodeURIComponent(turnId)}`,
      turnId,
      segments,
      live: turnId === activeTurnId && !finalAnswerTurnIds.has(turnId),
      loadMore: true,
    });
    processRows.forEach((row) => processRowKeys.add(row.key));
  }

  const projected: TranscriptTurnRow[] = [];
  const emittedWorkTurns = new Set<string>();
  for (const row of orderedRows) {
    const turnId = transcriptRowTurnId(row);
    const workRow = turnId ? workRowByTurn.get(turnId) : undefined;
    const openingUserRowKey = turnId ? openingUserRowKeyByTurn.get(turnId) : undefined;
    const firstProcessRowKey = workRow?.segments.flatMap((segment) => [segment.summary, ...segment.rows]).find((candidate): candidate is TranscriptRow => Boolean(candidate))?.key;
    if (turnId && workRow && !openingUserRowKey && firstProcessRowKey === row.key && !emittedWorkTurns.has(turnId)) {
      projected.push(workRow);
      emittedWorkTurns.add(turnId);
    }
    if (processRowKeys.has(row.key)) continue;
    projected.push(row);
    // Provider 的过程事件可能先于用户消息落库；展示顺序必须以轮次语义为准，不能把处理过程放到开场消息上方。
    if (turnId && workRow && openingUserRowKey === row.key && !emittedWorkTurns.has(turnId)) {
      projected.push(workRow);
      emittedWorkTurns.add(turnId);
    }
  }
  return projected;
}

function segmentTurnProcessRows(turnId: string, rows: readonly TranscriptRow[]): TranscriptTurnProcessSegment[] {
  const segments: Array<{ summary: TranscriptRow | null; rows: TranscriptRow[] }> = [];
  let current: { summary: TranscriptRow | null; rows: TranscriptRow[] } = { summary: null, rows: [] };
  const flush = (): void => {
    if (!current.summary && current.rows.length === 0) return;
    segments.push(current);
  };

  for (const row of rows) {
    if (isTurnStageSummaryRow(row)) {
      // Provider 在第一条用户可见摘要前通常已经产生了若干 reasoning。它们仍属于
      // 第一阶段的准备过程，不能单独生成一个没有摘要的“查看处理过程”，否则界面
      // 看起来仍像按整轮过程分组。首条摘要接管这些前置行；后续摘要才真正结束上一
      // 阶段并开启下一阶段。
      if (!current.summary && segments.length === 0) {
        current = { summary: row, rows: current.rows };
        continue;
      }
      flush();
      current = { summary: row, rows: [] };
      continue;
    }
    current.rows.push(row);
  }
  flush();

  return segments.map((segment, index) => {
    const identityRow = segment.summary ?? segment.rows[0];
    const identity = identityRow?.key ?? `empty-${index}`;
    return {
      key: `turn-process-stage:${encodeURIComponent(turnId)}:${encodeURIComponent(identity)}`,
      summary: segment.summary,
      rows: mergeStageActivityRows(segment.rows, turnId, identity),
    };
  });
}

function mergeStageActivityRows(rows: readonly TranscriptRow[], turnId: string, stageIdentity: string): TranscriptRow[] {
  const activityRows = rows.filter((row): row is Extract<TranscriptRow, { kind: 'activity' }> => row.kind === 'activity');
  if (activityRows.length <= 1) return [...rows];

  const items = activityRows.flatMap((row) => row.items);
  const categories = new Set(items.map(activityCategory));
  const merged: Extract<TranscriptRow, { kind: 'activity' }> = {
    kind: 'activity',
    key: `activity-stage:${encodeURIComponent(turnId)}:${encodeURIComponent(stageIdentity)}`,
    items,
    category: categories.size === 1 ? activityCategory(items[0]!) : 'mixed',
    motionActive: activityRows.some((row) => row.motionActive),
  };
  let emitted = false;
  const projected: TranscriptRow[] = [];
  for (const row of rows) {
    if (row.kind !== 'activity') {
      projected.push(row);
      continue;
    }
    if (emitted) continue;
    emitted = true;
    projected.push(merged);
  }
  return projected;
}

function isTurnStageSummaryRow(row: TranscriptRow): boolean {
  return row.kind === 'item' && isTurnStageSummaryItem(row.item);
}

/** 明确交付给用户的资源属于最终产物，统一放到该轮最终正文之后，不能夹在处理过程与正文之间。 */
function projectDeliverablesAfterFinalAnswer(rows: readonly TranscriptRow[]): readonly TranscriptRow[] {
  const finalAnswerKeyByTurn = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === 'item' && isFinalAnswerItem(row.item)) finalAnswerKeyByTurn.set(row.item.turnId, row.key);
  }
  if (finalAnswerKeyByTurn.size === 0) return rows;

  const deliverablesByTurn = new Map<string, TranscriptRow[]>();
  for (const row of rows) {
    if (row.kind !== 'item' || isFinalAnswerItem(row.item) || !isAssistantDeliverableItem(row.item) || !finalAnswerKeyByTurn.has(row.item.turnId)) continue;
    const deliverables = deliverablesByTurn.get(row.item.turnId) ?? [];
    deliverables.push(row);
    deliverablesByTurn.set(row.item.turnId, deliverables);
  }
  if (deliverablesByTurn.size === 0) return rows;

  const projected: TranscriptRow[] = [];
  for (const row of rows) {
    const turnId = transcriptRowTurnId(row);
    if (turnId && deliverablesByTurn.get(turnId)?.some((deliverable) => deliverable.key === row.key)) continue;
    projected.push(row);
    if (!turnId || finalAnswerKeyByTurn.get(turnId) !== row.key) continue;
    projected.push(...(deliverablesByTurn.get(turnId) ?? []));
  }
  return projected;
}

function isTurnProcessRow(row: TranscriptRow): boolean {
  if (row.kind === 'answered_request') return true;
  if (row.kind === 'activity') return true;
  // 计划和明确交付资源属于最终产物，必须独立展示，不能折叠进“已处理”过程。
  if (row.item.type === 'plan' || isAssistantDeliverableItem(row.item)) return false;
  // 只有缺少 phase 的旧 assistant 正文才走兼容兜底；明确 prework 必须留在处理过程。
  if (row.item.type === 'agentMessage' && itemRole(row.item) === 'assistant' && !itemProviderPhase(row.item)) return false;
  return itemRole(row.item) !== 'user' && !isFinalAnswerItem(row.item);
}

function transcriptRowTurnId(row: TranscriptRow): string | null {
  if (row.kind === 'answered_request') return row.request.turnId;
  return row.kind === 'item' ? row.item.turnId : (row.items[0]?.turnId ?? null);
}

function turnProcessExpansionKey(identity: string): string {
  return `turn-process:${identity}`;
}

function defaultExpandedTurnProcessKeys(rows: readonly TranscriptTurnRow[], turnsByProviderId: NativeSessionState['turnsByProviderId'], terminalTurnIds: NativeSessionState['terminalTurnIds']): ReadonlySet<string> {
  const expanded = new Set(rows.filter((row): row is TranscriptTurnWorkRow => row.kind === 'turn_work' && row.live).map((row) => turnProcessExpansionKey(row.key)));
  let latestTurnId: string | null = null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    latestTurnId = transcriptTurnRowTurnId(rows[index]!);
    if (latestTurnId) break;
  }
  if (!latestTurnId) return expanded;

  const turn = turnsByProviderId[latestTurnId] ?? Object.values(turnsByProviderId).find((candidate) => candidate.id === latestTurnId || candidate.providerTurnId === latestTurnId);
  const providerTurnId = turn?.providerTurnId;
  const interrupted = terminalTurnIds[latestTurnId] === 'interrupted' || (providerTurnId ? terminalTurnIds[providerTurnId] === 'interrupted' : false) || turn?.status === 'interrupted';
  if (!interrupted) return expanded;

  // 编排层会把意外退出后的轮次写成 interrupted 终态，但产品语义仍是“过程没有正常结束”。
  // 只让最后一轮中断过程默认展开，避免旧中断记录把整段历史长期撑开；用户仍可手动收起。
  const interruptedTurnIds = new Set([latestTurnId, providerTurnId, turn?.id].filter((turnId): turnId is string => Boolean(turnId)));
  const latestInterruptedProcess = [...rows].reverse().find((row): row is TranscriptTurnWorkRow => row.kind === 'turn_work' && interruptedTurnIds.has(row.turnId));
  if (latestInterruptedProcess) expanded.add(turnProcessExpansionKey(latestInterruptedProcess.key));
  return expanded;
}

function transcriptTurnRowTurnId(row: TranscriptTurnRow): string | null {
  return row.kind === 'turn_work' ? row.turnId : transcriptRowTurnId(row);
}

function transcriptRowContainsItemKey(row: TranscriptRow, itemKey: string | undefined): boolean {
  if (!itemKey || row.kind === 'answered_request') return false;
  return row.kind === 'item' ? row.item.key === itemKey : row.items.some((item) => item.key === itemKey);
}

export function isFinalAnswerItem(item: NativeSessionItemBuffer): boolean {
  const providerPhase = itemProviderPhase(item);
  return itemRole(item) === 'assistant' && (providerPhase === 'final_answer' || providerPhase === 'finalAnswer');
}

function itemProviderPhase(item: NativeSessionItemBuffer): string {
  return typeof item.payload.phase === 'string' ? item.payload.phase : item.phase;
}

export function projectTranscriptRows(
  items: readonly NativeSessionItemBuffer[],
  answeredRequests: readonly NativePendingRequest[] = [],
  activeTurnId: string | null = null,
  historyOnly = false,
  terminalTurnIds: NativeSessionState['terminalTurnIds'] = {},
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const candidateActiveTurnId = historyOnly ? null : activeTurnId && items.some((item) => item.turnId === activeTurnId) ? activeTurnId : latestLiveTurnId(items);
  // Provider 可能在终态到达后仍留下一条 in_progress reasoning；终态表优先，不能把旧摘要重新判成当前执行。
  const effectiveActiveTurnId = candidateActiveTurnId && !terminalTurnIds[candidateActiveTurnId] ? candidateActiveTurnId : null;
  const currentActivityItemKey = latestCurrentActivityItemKey(items, effectiveActiveTurnId);
  const timeline: Array<{ kind: 'item'; item: NativeSessionItemBuffer } | { kind: 'answered_request'; request: NativePendingRequest }> = items.map((item) => ({ kind: 'item', item }));
  for (const request of [...answeredRequests].sort((left, right) => (left.resolvedAt ?? left.createdAt).localeCompare(right.resolvedAt ?? right.createdAt))) {
    // 缺少轮次身份的旧记录不能靠时间猜测归属，也不能重新污染主会话时间线。
    if (!request.turnId) continue;
    const requestTimelineAt = request.resolvedAt ?? request.createdAt;
    // 已回答询问按答案提交时间落位；普通条目使用首次进入时间线的稳定时间，不能用流式更新后的时间重排。
    const insertionIndex = timeline.findIndex((entry) => entry.kind === 'item' && (entry.item.timelineAt ?? entry.item.updatedAt ?? '') >= requestTimelineAt);
    timeline.splice(insertionIndex < 0 ? timeline.length : insertionIndex, 0, { kind: 'answered_request', request });
  }

  // 阶段边界来自用户真正看到的中间摘要回复，而不是内部 reasoning 或整轮 turnId。
  // 同一摘要之后、下一摘要之前发生的命令/工具/文件操作共享一个活动组，避免整轮几十条操作被错误压成一组。
  const stageOrdinalByTurn = new Map<string, number>();
  const stageIdentityByTimelineIndex = new Map<number, string>();
  timeline.forEach((entry, index) => {
    const turnId = entry.kind === 'item' ? entry.item.turnId : entry.request.turnId;
    if (!turnId) return;
    let ordinal = stageOrdinalByTurn.get(turnId) ?? 0;
    if (entry.kind === 'item' && isTurnStageSummaryItem(entry.item)) {
      ordinal += 1;
      stageOrdinalByTurn.set(turnId, ordinal);
    }
    stageIdentityByTimelineIndex.set(index, `${turnId}\u0000${ordinal}`);
  });

  const activitiesByStage = new Map<string, NativeSessionItemBuffer[]>();
  timeline.forEach((entry, index) => {
    const stageIdentity = stageIdentityByTimelineIndex.get(index);
    if (entry.kind !== 'item' || isSubagentCoordinationItem(entry.item) || !isOperationalActivityItem(entry.item)) return;
    const activityStageIdentity = stageIdentity ?? `${entry.item.turnId}\u00000`;
    const activities = activitiesByStage.get(activityStageIdentity) ?? [];
    activities.push(entry.item);
    activitiesByStage.set(activityStageIdentity, activities);
  });
  const emittedActivityStages = new Set<string>();
  const activeReasoningItem =
    effectiveActiveTurnId && !items.some((item) => item.turnId === effectiveActiveTurnId && isFinalAnswerItem(item))
      ? [...items].reverse().find((item) => item.turnId === effectiveActiveTurnId && normalizeItemType(item.type) === 'reasoning')
      : undefined;

  for (let index = 0; index < timeline.length; index += 1) {
    const entry = timeline[index]!;
    if (entry.kind === 'answered_request') {
      rows.push({ kind: 'answered_request', key: `answered-request:${entry.request.id}`, request: entry.request });
    } else {
      const item = entry.item;
      // 多智能体协调事件统一进入右侧智能体面板，不在主会话重复暴露协议载荷。
      if (!isSubagentCoordinationItem(item)) {
        const stageIdentity = stageIdentityByTimelineIndex.get(index) ?? `${item.turnId}\u00000`;
        // Reasoning 只表达活动轮次的当前状态，不是历史正文。当前轮只保留最新一条，
        // 并在完成普通时间线投影后固定放到该轮最底部；最终回答到达或轮次结束后全部隐藏。
        if (normalizeItemType(item.type) === 'reasoning') continue;
        if (!isOperationalActivityItem(item)) {
          rows.push({ kind: 'item', key: transcriptItemRenderKey(item), item });
        } else {
          if (emittedActivityStages.has(stageIdentity)) continue;
          emittedActivityStages.add(stageIdentity);
          const groupedItems = activitiesByStage.get(stageIdentity) ?? [item];
          const categories = new Set(groupedItems.map(activityCategory));
          rows.push({
            kind: 'activity',
            key: `activity:${encodeURIComponent(stageIdentity)}`,
            items: groupedItems,
            category: categories.size === 1 ? activityCategory(groupedItems[0]!) : 'mixed',
            motionActive: groupedItems.some((candidate) => candidate.key === currentActivityItemKey),
          });
        }
      }
    }
  }
  if (activeReasoningItem) {
    const reasoningRow: TranscriptRow = { kind: 'item', key: transcriptItemRenderKey(activeReasoningItem), item: activeReasoningItem };
    let lastActiveTurnRowIndex = rows.length - 1;
    while (lastActiveTurnRowIndex >= 0 && transcriptRowTurnId(rows[lastActiveTurnRowIndex]!) !== activeReasoningItem.turnId) lastActiveTurnRowIndex -= 1;
    rows.splice(lastActiveTurnRowIndex < 0 ? rows.length : lastActiveTurnRowIndex + 1, 0, reasoningRow);
  }
  return rows;
}

function isTurnStageSummaryItem(item: NativeSessionItemBuffer): boolean {
  if (normalizeItemType(item.type) === 'reasoning' || item.type === 'plan' || isFinalAnswerItem(item) || isAssistantDeliverableItem(item)) return false;
  const role = itemRole(item);
  return (role === 'assistant' || role === 'commentary') && transcriptItemText(item).trim().length > 0;
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

/** 交付卡跟随该轮最终产物：优先在正文后的显式交付资源下方，无正文时才退回时间线末项。 */
function turnArtifactAnchorKeyByTurn(rows: readonly TranscriptRow[]): Record<string, string> {
  const result = lastVisibleItemKeyByTurn(rows);
  const turnsWithFinalAnswer = new Set<string>();
  for (const row of projectDeliverablesAfterFinalAnswer(rows)) {
    if (row.kind !== 'item') continue;
    if (isFinalAnswerItem(row.item)) {
      turnsWithFinalAnswer.add(row.item.turnId);
      result[row.item.turnId] = row.item.key;
      continue;
    }
    if (turnsWithFinalAnswer.has(row.item.turnId) && isAssistantDeliverableItem(row.item)) result[row.item.turnId] = row.item.key;
  }
  return result;
}

export function isSubagentCoordinationItem(item: Pick<NativeSessionItemBuffer, 'type' | 'payload'>): boolean {
  const rawType = typeof item.payload.type === 'string' ? item.payload.type : item.type;
  const type = rawType.toLowerCase().replaceAll(/[^a-z]/gu, '');
  return type === 'collabagenttoolcall' || type === 'subagentactivity';
}

function transcriptItemRenderKey(item: NativeSessionItemBuffer): string {
  // 活动轮次只投影一条当前摘要；Provider 换 item 时仍沿用轮次级 DOM 身份，
  // 让文字原位更新并固定在过程底部，不因新 item 被卸载后重新跳位。
  if (normalizeItemType(item.type) === 'reasoning') return `reasoning-summary:${encodeURIComponent(item.turnId)}`;
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

function transcriptPayloadString(item: NativeSessionItemBuffer, key: string): string | undefined {
  const value = item.payload[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function transcriptUserMessageClientIds(item: NativeSessionItemBuffer): string[] {
  return [item.clientUserMessageId, item.durableClientUserMessageId, transcriptPayloadString(item, 'clientId'), transcriptPayloadString(item, 'clientUserMessageId')].filter(
    (value, index, values): value is string => Boolean(value) && values.indexOf(value) === index,
  );
}

function transcriptUserMessageIdentities(item: NativeSessionItemBuffer): string[] {
  return [
    ...transcriptUserMessageClientIds(item).map((value) => `client:${value}`),
    ...(transcriptPayloadString(item, 'submissionId') ? [`submission:${transcriptPayloadString(item, 'submissionId')}`] : []),
    ...(item.providerItemId ? [`provider:${item.providerItemId}`] : []),
  ];
}

function hasScopedDeliveryFailure(item: NativeSessionItemBuffer): boolean {
  if (item.status !== 'failed' && item.status !== 'unconfirmed' && item.status !== 'paused') return false;
  return Boolean(nativeSessionErrorFrom(item.payload.deliveryError) ?? nativeSessionErrorFrom(item.payload.error));
}

/** 同一持久 submission 即使从本地消息、队列和 Provider 三条路径到达，也只保留一个稳定气泡。 */
function coalesceTranscriptUserMessages(items: readonly NativeSessionItemBuffer[]): NativeSessionItemBuffer[] {
  const projected: NativeSessionItemBuffer[] = [];
  const indexByIdentity = new Map<string, number>();
  for (const item of items) {
    if (itemRole(item) !== 'user') {
      projected.push(item);
      continue;
    }
    const identities = transcriptUserMessageIdentities(item);
    const existingIndex = identities.map((identity) => indexByIdentity.get(identity)).find((index): index is number => index !== undefined);
    if (existingIndex === undefined) {
      const index = projected.push(item) - 1;
      for (const identity of identities) indexByIdentity.set(identity, index);
      continue;
    }
    const existing = projected[existingIndex]!;
    const durable = !existing.optimistic ? existing : !item.optimistic ? item : existing;
    const delivery = hasScopedDeliveryFailure(item) ? item : hasScopedDeliveryFailure(existing) ? existing : durable;
    const merged: NativeSessionItemBuffer = {
      ...durable,
      key: existing.key,
      text: durable.text || existing.text || item.text,
      status: delivery.status,
      payload: { ...existing.payload, ...item.payload },
      resources: durable.resources.length ? durable.resources : existing.resources.length ? existing.resources : item.resources,
      optimistic: hasScopedDeliveryFailure(delivery) ? true : durable.optimistic,
      clientUserMessageId: durable.clientUserMessageId ?? existing.clientUserMessageId ?? item.clientUserMessageId,
      durableClientUserMessageId: durable.durableClientUserMessageId ?? existing.durableClientUserMessageId ?? item.durableClientUserMessageId,
      timelineAt: existing.timelineAt ?? item.timelineAt,
      updatedAt: item.updatedAt ?? existing.updatedAt,
    };
    projected[existingIndex] = merged;
    for (const identity of [...transcriptUserMessageIdentities(existing), ...identities, ...transcriptUserMessageIdentities(merged)]) indexByIdentity.set(identity, existingIndex);
  }
  return projected;
}

/**
 * 旧版队列恢复会把原 submission 标记为 interrupted，随后用新的客户端身份创建
 * Provider 接管项。两条记录都必须保留审计事实，但转录里不能把同一次发送画成两个
 * 用户气泡。这里只接受“无结构化载荷、正文完全相同、旧项更新时间与 Provider 项
 * 相差不超过 5 秒”的强证据；普通重复发送、失败后隔一段时间重发和附件消息均保留。
 */
export function coalesceSupersededInterruptedQueuedUserMessages(items: readonly NativeSessionItemBuffer[]): NativeSessionItemBuffer[] {
  const durableByFingerprint = new Map<string, NativeSessionItemBuffer[]>();
  for (const item of items) {
    const fingerprint = simpleUserMessageFingerprint(item);
    if (!fingerprint || item.optimistic || !item.providerItemId) continue;
    const candidates = durableByFingerprint.get(fingerprint) ?? [];
    candidates.push(item);
    durableByFingerprint.set(fingerprint, candidates);
  }
  return items.filter((item) => {
    if (!item.optimistic || item.status !== 'paused' || item.payload.pausedReason !== 'interrupted' || item.payload.delivery !== 'queue') return true;
    const fingerprint = simpleUserMessageFingerprint(item);
    const interruptedAt = timestampMillis(item.updatedAt);
    if (!fingerprint || interruptedAt === null) return true;
    return !(durableByFingerprint.get(fingerprint) ?? []).some((candidate) => {
      const acceptedAt = timestampMillis(transcriptTimelineAt(candidate));
      return acceptedAt !== null && Math.abs(acceptedAt - interruptedAt) <= 5_000;
    });
  });
}

function simpleUserMessageFingerprint(item: NativeSessionItemBuffer): string | null {
  if (itemRole(item) !== 'user' || item.resources.length > 0) return null;
  if (Array.isArray(item.payload.attachments) && item.payload.attachments.length > 0) return null;
  if (Array.isArray(item.payload.browserComments) && item.payload.browserComments.length > 0) return null;
  if (recordValue(item.payload.conversationContext) || recordValue(item.payload.taskPushLayout)) return null;
  const text = transcriptItemText(item).trim();
  return text || null;
}

function timestampMillis(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUnacceptedQueuedUserItem(item: NativeSessionItemBuffer, queuedClientUserMessageIds: ReadonlySet<string>): boolean {
  if (!item.optimistic || itemRole(item) !== 'user' || item.payload.delivery !== 'queue') return false;
  // 已落库的本地 userMessage 只是仍在等待 Provider 接纳，不应再被队列替身挤掉。
  if (item.localItemId) return false;
  const clientUserMessageId = transcriptUserMessageClientIds(item)[0];
  // Provider 的 active turn 会早于 userMessage/模型历史投影到达。此时不能因为 pending turn id
  // 与 Provider turn id 不同就隐藏本地气泡；只有队列已经用同一客户端身份画出替身时才去重。
  return Boolean(clientUserMessageId && queuedClientUserMessageIds.has(clientUserMessageId));
}

function visibleQueuedSubmissions(queue: NativeQueueSnapshot | null) {
  return [...(queue?.submissions ?? [])]
    .filter((submission) => (submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'steering' || submission.status === 'paused') && !submission.providerTurnId)
    .sort((left, right) => left.position - right.position || (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id));
}

function queuedSubmissionForItem(item: NativeSessionItemBuffer, queue: NativeQueueSnapshot | null): NativeQueuedSubmission | null {
  const submissionIds = [item.localItemId, item.itemId, primitiveValue(item.payload.submissionId)].filter((value): value is string => Boolean(value));
  if (submissionIds.length === 0) return null;
  const identities = new Set(submissionIds);
  return queue?.submissions.find((submission) => identities.has(submission.id)) ?? null;
}

function queuedSteerUnavailableReason(state: NativeSessionState, submission: NativeQueuedSubmission, language: SessionUiLanguage): string | null {
  const queueHead = [...(state.queue?.submissions ?? [])]
    .filter((candidate) => candidate.status === 'queued' || candidate.status === 'paused' || candidate.status === 'failed')
    .sort((left, right) => left.position - right.position || (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id))[0];
  if (!queueHead) return language === 'zh-CN' ? '队列状态尚未就绪' : 'The queue state is not ready yet';
  if (queueHead.id !== submission.id) return language === 'zh-CN' ? '请先处理更早的排队消息' : 'Handle the earlier queued message first';
  if (!canSteerActiveTurn(state)) return language === 'zh-CN' ? '当前回复还未准备好接受引导' : 'The current response is not ready for steering';
  return null;
}

/**
 * Provider 轮次建立前就暂停的提交同样是已落库历史。它们不能只存在于队列状态里，
 * 否则冷开会话会过滤掉乐观消息，并把用户已经发送的内容渲染成整页空白。
 */
function projectQueuedSubmissionItems(state: NativeSessionState, submissions: ReturnType<typeof visibleQueuedSubmissions>, persistedItems: readonly NativeSessionItemBuffer[]): NativeSessionItemBuffer[] {
  const visibleSubmissionIds = new Set(persistedItems.flatMap((item) => [item.localItemId, item.itemId, transcriptPayloadString(item, 'submissionId')]).filter((value): value is string => Boolean(value)));
  const visibleClientMessageIds = new Set(
    persistedItems
      .filter((item) => itemRole(item) === 'user')
      .flatMap(transcriptUserMessageClientIds)
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
          submissionId: submission.id,
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
  const interactionAuthorityMissing = state.queue?.state.type === 'paused' && state.queue.state.reason === 'interaction_authority_missing';
  if (!state.activeTurnId || interactionAuthorityMissing || userBlockingConversationStates.has(state.conversationState)) return showThinking ? { kind: 'thinking' } : null;
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
