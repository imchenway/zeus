import { matchingInlineResource } from './ConversationMarkdown.js';
import { inlineResourceRequestSignature } from './conversationResourceProjection.js';
import { createTranscriptProjection, reuseTranscriptRows, reuseTranscriptTurnRows, updateTranscriptProjection, type TranscriptProjection } from './transcriptProjection.js';
import { asyncQuestionAnswerHistory, AsyncQuestionMessage } from './AsyncQuestionMessage.js';
import { classifyAssistantMessage, conversationNavigationExcerpt, conversationQuestionNavigationExcerpt, type ConversationNavigationSnapshot, type AsyncQuestionAnswer } from '@zeus/shared';
import type { UserFacingErrorCause } from '@zeus/shared';
import { userFacingErrorCause } from '@zeus/shared';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { activityCategory, isActiveSessionTurn, isLiveActivityItem, isOperationalActivityItem, type SessionActivityCategory, SessionActivityGroup, SessionTurnDuration, SessionTurnProcessDisclosure } from './SessionActivity.js';
import { itemRole, type SessionUiLanguage, ThreadItemView, transcriptItemText } from './ThreadItemView.js';
import { PlanSummary } from './PlanSummary.js';
import { WifiHighIcon } from '@phosphor-icons/react/dist/csr/WifiHigh';
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
import { type ConversationFileLocation, type ConversationOpenTarget, type ConversationResponseAnnotation, type ConversationResponseTextAnchor, parseCanonicalRequestUserInputQuestions } from '@zeus/shared';
import { useThreadScrollController } from './useThreadScrollController.js';
import { TurnChangeCard } from './TurnChanges.js';
import { latestReasoningSummaryText, reasoningSummaryStatus, SessionReasoningSummary, SessionSweepText } from './SessionReasoningSummary.js';
import { AnsweredRequestHistory, isAnsweredUserInputRequest, type AnsweredRequestHistoryProps } from './AnsweredRequestHistory.js';
import { newItemMotionDurationMs, useNewItemMotionIds } from '../ui/useNewItemMotion.js';
import { captureTranscriptViewportAnchor, compensateTranscriptViewportAnchor, type TranscriptViewportAnchor, useTranscriptViewportVirtualizer } from './transcriptViewportVirtualizer.js';
import { reportApplicationError, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { isImageResource } from './ConversationResources.js';
import { ConversationImageResourcesContext, hasMissingMarkdownImages } from './ConversationMarkdown.js';
import { composerQueuedSubmissions, isUnacceptedTranscriptMessage, orderTranscriptItemsWithQueue, visibleQueuedSubmissions } from './conversationQueuePresentation.js';
import type { McpAppToolCall, McpAppToolResult } from './McpAppFrame.js';
import { ConversationNavigation, mergeNavigationEntries, navigationRowKey, useConversationNavigation, type TranscriptNavigationEntry } from './ConversationNavigation.js';

export interface ConversationTranscriptProps {
  /** 主会话读取完整目录，独立子线程不传此入口。 */
  onLoadNavigation?: () => Promise<ConversationNavigationSnapshot>;
  /** 按需读取选中轮次的正文，不展开工具过程。 */
  onLoadNavigationTurn?: (turnId: string) => Promise<void>;
  state: NativeSessionState;
  language: SessionUiLanguage;
  assistantLabel?: string;
  historyOnly?: boolean;
  /** 子线程等只读投影没有主会话快照时，仍可明确声明时间线已完成水合。 */
  transcriptHydrated?: boolean;
  /** 从历史入口打开后持续补齐已持久化计划；首次续聊不能让旧计划从时间线消失。 */
  projectPersistedPlans?: boolean;
  onEditUserItem?: (item: NativeSessionItemBuffer, content: string) => void | Promise<void>;
  openPlanItem?: NativeSessionItemBuffer | null;
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
  onLoadEarlierHistory?: () => void | Promise<void>;
  /** 深历史可能没有有界轮次 DTO，展开入口同时传递是否应从头读取。 */
  onLoadTurnProcess?: (turnId: string, startAtBeginning?: boolean) => void | Promise<void>;
  onLoadConversationResources?: () => void | Promise<void>;
  onLoadTurnArtifacts?: (turnId: string) => void | Promise<void>;
  onLoadV2Content?: (handle: string) => Promise<void>;
  onLoadV2ToolResult?: (handle: string, offset?: number) => Promise<NativeConversationToolResultPage>;
  /** 打开现有登录或模型设置页，不代替用户修改配置。 */
  onOpenAiSettings?: (section: 'runtime' | 'models') => void;
  onRecoverQueue?: () => void | Promise<void>;
  onReconnectCodex?: () => void | Promise<void>;
  onInterrupt?: (turnId: string) => void | Promise<void>;
  onRetryQueuedSubmission?: (submissionId: string) => void | Promise<void>;
  onRetryPendingSend?: (clientUserMessageId: string, intent: 'check' | 'continue') => void | Promise<void>;
  onCancelPendingSend?: (clientUserMessageId: string) => void | Promise<void>;
  onCancelQueuedSubmission?: (submissionId: string) => void | Promise<void>;
  /** 时间线入口只打开底部答题区，不在历史中展开表单。 */
  onOpenAsyncQuestion?: (item: NativeSessionItemBuffer) => void;
  /** 当前会话工作面每次本地提交或编辑重发后递增；不依赖异步 Provider 投影推断用户发送。 */
  localSubmissionRevision?: number;
}

export interface SessionCreationStatus {
  /** 创建失败的可选原始原因。 */
  errorCause?: UserFacingErrorCause;
  state: 'creating' | 'retrying' | 'failed' | 'warning';
  message: string;
  retryAttempt?: number;
  maxRetries?: number;
  error?: string | null;
  retryLabel?: string;
  onRetry?: () => void | Promise<void>;
}

/** 连接与创建重试共用库内无线图标，动效由现有状态容器控制。 */
const sessionConnectionSymbol = (
  <span className="session-connection-symbol" aria-hidden="true">
    <WifiHighIcon weight="regular" />
  </span>
);

/** 会话错误和消息状态共用警示图标，不依赖背景颜色区分提示。 */
const turnFailureSymbol = (
  <span className="session-turn-failure-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5" />
      <circle cx="12" cy="16.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  </span>
);

const emptyResponseAnnotations: ConversationResponseAnnotation[] = [];
const userScrollIntentIdleMs = 180;
const latestPositionFallbackMs = 80;
const transcriptVerticalScrollKeys = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' ', 'Spacebar']);

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

/** 正文中的受信链接与图片都需要资源登记，不能等待用户展开处理过程。 */
function itemNeedsInlineResources(item: NativeSessionItemBuffer): boolean {
  /** 仅完整的 Markdown 链接触发补载；实际打开仍由已登记资源授权。 */
  const links = [...transcriptItemText(item).matchAll(/(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/gu)];
  if (
    links.some((match) => {
      const href = match[2]!.trim().replace(/^<|>$/gu, '');
      if (href.startsWith('#')) return false;
      return !matchingInlineResource(item.resources, match[1]!, href);
    })
  )
    return true;
  if (hasMissingMarkdownImages(transcriptItemText(item), item.resources)) return true;
  if (item.optimistic) return false;
  return imageAttachmentDescriptors(item).some(
    (attachment) =>
      !item.resources.some(
        (resource) => resource.kind === 'attachment' && isImageResource(resource) && ((attachment.taskPushAttachmentKey && resource.taskPushAttachmentKey === attachment.taskPushAttachmentKey) || resource.displayName === attachment.name),
      ),
  );
}

function isRecoveredRequestUserInputItem(item: NativeSessionItemBuffer): boolean {
  return normalizeItemType(item.type) === 'requestuserinput' && item.payload.recovery === 'content_only';
}

function requestUserInputQuestionIdentity(payload: unknown): string | null {
  const parsed = parseCanonicalRequestUserInputQuestions(payload);
  if (!parsed.ok) return null;
  return JSON.stringify(
    parsed.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options,
    })),
  );
}

function authoritativeRequestMatchesRecoveredItem(request: NativePendingRequest, item: NativeSessionItemBuffer): boolean {
  if (normalizeItemType(request.type) !== 'requestuserinput') return false;
  const recoveredProviderItemId = typeof item.payload.providerItemId === 'string' ? item.payload.providerItemId : null;
  if (recoveredProviderItemId && request.itemId === recoveredProviderItemId) return true;
  const recoveredProviderTurnId = typeof item.payload.providerTurnId === 'string' ? item.payload.providerTurnId : null;
  const requestProviderTurnId = typeof request.payload.turnId === 'string' ? request.payload.turnId : null;
  if (recoveredProviderTurnId && requestProviderTurnId && recoveredProviderTurnId !== requestProviderTurnId) return false;
  const recoveredIdentity = requestUserInputQuestionIdentity(item.payload);
  return recoveredIdentity !== null && recoveredIdentity === requestUserInputQuestionIdentity(request.payload);
}

export function hasUnclaimedRecoveredRequestUserInput(state: NativeSessionState): boolean {
  return Object.values(state.items).some(
    (item) =>
      isRecoveredRequestUserInputItem(item) &&
      item.payload.outcome === 'pending' &&
      (!state.activeTurnId || item.turnId === state.activeTurnId) &&
      !state.pendingRequests.some((request) => authoritativeRequestMatchesRecoveredItem(request, item)),
  );
}

/** 正文与过程共用加载状态，保留游标方向以决定补页位置。 */
function turnDetailPaging(snapshot: NativeSessionState['snapshot'], turnId: string) {
  const process = snapshot?.v2Paging?.processByTurn[turnId];
  // v0.3.46 之前已经留在 Renderer 内存中的分页对象没有 historyByTurn。
  // 升级后第一次打开历史会话必须把它视为空映射，而不是在旧快照上崩溃。
  const history = snapshot?.v2Paging?.historyByTurn?.[turnId];
  if (!process && !history) return undefined;
  return {
    direction: process?.direction ?? history?.direction ?? 'forward',
    loading: Boolean(process?.loading || history?.loading),
    error: process?.error ?? history?.error ?? null,
    loaded: Boolean(process?.loaded || history?.loaded),
    hasMore: Boolean(process?.hasMore || history?.hasMore),
    /** 正文与过程独立推进，任一游标变化都允许读取下一批。 */
    cursor: JSON.stringify([process?.nextCursor ?? null, history?.nextCursor ?? null]),
  };
}

/** 展开准备尚未读取的详情或恢复失败页；后续页由可见边界自动补齐。 */
function turnProcessNeedsLoad(paging: ReturnType<typeof turnDetailPaging>): boolean {
  return !paging?.loading && (!paging?.loaded || Boolean(paging.error));
}

function turnProcessAvailable(snapshot: NativeSessionState['snapshot'], turnId: string): boolean {
  const v2 = snapshot?.snapshotV2;
  if (!v2) return false;
  const turn = [...v2.recentClosedTurns, ...(v2.activeTurn ? [v2.activeTurn] : [])].find((candidate) => candidate.id === turnId || candidate.providerTurnId === turnId);
  return turn?.process.available ?? false;
}

function availableTurnProcessIds(snapshot: NativeSessionState['snapshot']): ReadonlySet<string> {
  const v2 = snapshot?.snapshotV2;
  if (!v2) return new Set();
  return new Set([...v2.recentClosedTurns, ...(v2.activeTurn ? [v2.activeTurn] : [])].filter((turn) => turn.process.available).map((turn) => turn.providerTurnId ?? turn.id));
}

function availableClosedTurnChangeSetIds(snapshot: NativeSessionState['snapshot']): readonly string[] {
  return snapshot?.snapshotV2?.recentClosedTurns.filter((turn) => turn.changeSetAvailable).map((turn) => turn.providerTurnId ?? turn.id) ?? [];
}

function useStableOptionalCallback<Arguments extends unknown[], Result>(callback: ((...args: Arguments) => Result) | undefined): ((...args: Arguments) => Result) | undefined {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const stableCallback = useCallback((...args: Arguments): Result => callbackRef.current!(...args), []);
  return callback ? stableCallback : undefined;
}

/** 会话正文、历史过程与当前状态共用原始事件，仅在展示时分配提示职责。 */
export function ConversationTranscript(props: ConversationTranscriptProps) {
  /** 导航和预览共用会话外壳，不被正文滚动裁切。 */
  const shellRef = useRef<HTMLDivElement | null>(null);
  /** 显式跳转目标先加入虚拟列表，挂载后再校准。 */
  const [navigationTargetKey, setNavigationTargetKey] = useState<string | null>(null);
  /** 仅在阅读位置跨过发言时更新当前刻度。 */
  const [activeNavigationKey, setActiveNavigationKey] = useState<string | null>(null);
  /** 跳转读取失败留在当前工作面，不覆盖正文错误状态。 */
  const [navigationReadError, setNavigationReadError] = useState<{ entry: TranscriptNavigationEntry; message: string } | null>(null);
  /** 连续点击和会话切换后，旧读取错误不能覆盖当前目标。 */
  const navigationRequestRef = useRef(0);
  const containerRef = useRef<HTMLElement | null>(null);
  const latestContentMarkerRef = useRef<HTMLSpanElement | null>(null);
  const latestMarkerIntersectingRef = useRef(true);
  const latestPositionFrameRef = useRef<number | null>(null);
  const latestPositionFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestPositionConvergenceRequestedRef = useRef(false);
  const maintainLatestPositionRef = useRef<() => void>(() => undefined);
  const latestVisibilityFrameRef = useRef<number | null>(null);
  const lastReportedLatestVisibilityRef = useRef<boolean | null>(null);
  const latestVisibilityCallbackRef = useRef(props.onLatestContentVisibilityChange);
  latestVisibilityCallbackRef.current = props.onLatestContentVisibilityChange;
  const historyPrependAnchorRef = useRef<(TranscriptViewportAnchor & { frozenCursor: string }) | null>(null);
  const staticReadingAnchorRef = useRef<TranscriptViewportAnchor | null>(null);
  /** 展开状态提交后立即补偿入口本身，避免首帧先跳动再由测量器纠正。 */
  const pendingProcessAnchorRef = useRef<{ trigger: HTMLButtonElement; top: number } | null>(null);
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
  const trackedLocalSubmissionRef = useRef<{ conversationId: string | null; revision: number }>({ conversationId: null, revision: 0 });
  const userScrollIntentRef = useRef(false);
  const userScrollPointerActiveRef = useRef(false);
  const userScrollIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const automaticResourceLoadAttemptRef = useRef<string | null>(null);
  const [rowExpansionOverrides, setRowExpansionOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [historyAnchorRowKey, setHistoryAnchorRowKey] = useState<string | null>(null);
  const [staticReadingAnchorRowKey, setStaticReadingAnchorRowKey] = useState<string | null>(null);
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
  const scheduleUserScrollIntentEnd = useCallback(() => {
    if (userScrollIntentTimerRef.current) clearTimeout(userScrollIntentTimerRef.current);
    userScrollIntentTimerRef.current = setTimeout(() => {
      userScrollIntentTimerRef.current = null;
      if (!userScrollPointerActiveRef.current) {
        userScrollIntentRef.current = false;
        if (scrollController.getState().mode !== 'static') maintainLatestPositionRef.current();
      }
    }, userScrollIntentIdleMs);
  }, [scrollController]);
  const beginUserScrollIntent = useCallback(
    (pointerActive = false) => {
      userScrollIntentRef.current = true;
      if (pointerActive) {
        userScrollPointerActiveRef.current = true;
        if (userScrollIntentTimerRef.current) clearTimeout(userScrollIntentTimerRef.current);
        userScrollIntentTimerRef.current = null;
        return;
      }
      scheduleUserScrollIntentEnd();
    },
    [scheduleUserScrollIntentEnd],
  );
  const finishUserScrollPointerIntent = useCallback(() => {
    if (!userScrollPointerActiveRef.current) return;
    userScrollPointerActiveRef.current = false;
    scheduleUserScrollIntentEnd();
  }, [scheduleUserScrollIntentEnd]);
  const clearUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = false;
    userScrollPointerActiveRef.current = false;
    if (userScrollIntentTimerRef.current) clearTimeout(userScrollIntentTimerRef.current);
    userScrollIntentTimerRef.current = null;
  }, []);
  const clearStaticReadingAnchor = useCallback(() => {
    staticReadingAnchorRef.current = null;
    setStaticReadingAnchorRowKey((current) => (current === null ? current : null));
  }, []);
  const rememberStaticReadingAnchor = useCallback((container: HTMLElement) => {
    const anchor = captureTranscriptViewportAnchor(container);
    staticReadingAnchorRef.current = anchor;
    setStaticReadingAnchorRowKey((current) => (current === anchor.rowKey ? current : anchor.rowKey));
  }, []);
  const getStaticReadingAnchor = useCallback(() => staticReadingAnchorRef.current, []);
  const updateHistorySentinelIntersection = useCallback((intersecting: boolean) => setHistorySentinelIntersection({ conversationId: props.state.conversationId, intersecting }), [props.state.conversationId]);
  const activeTurnId = props.historyOnly ? null : props.state.activeTurnId;
  const queuedSubmissions = useMemo(() => visibleQueuedSubmissions(props.state.queue), [props.state.queue]);
  /** 输入框卡片接管的提交不能同时出现在会话时间线。 */
  const composerQueue = useMemo(() => composerQueuedSubmissions(props.state), [props.state.itemOrder, props.state.items, props.state.queue]);
  /** 稳定提交身份覆盖冷开时由持久 submission 重建的本地消息。 */
  const composerQueueSubmissionIds = useMemo(() => new Set(composerQueue.map((submission) => submission.id)), [composerQueue]);
  /** 客户端消息身份覆盖首次提交后尚未取得本地提交身份的乐观消息。 */
  const composerQueueClientUserMessageIds = useMemo(() => new Set(composerQueue.map((submission) => submission.clientUserMessageId).filter((value): value is string => Boolean(value))), [composerQueue]);
  /** 引导、失败和恢复项仍由时间线承载，只有普通等待项进入输入框卡片。 */
  const transcriptQueuedSubmissions = useMemo(() => queuedSubmissions.filter((submission) => !composerQueueSubmissionIds.has(submission.id)), [composerQueueSubmissionIds, queuedSubmissions]);
  /** 内容批次复用已建立的输入、阶段和父组索引。 */
  const previousProjection = useRef<TranscriptProjection | null>(null);
  const projectionContext = [
    props.state.conversationId,
    props.state.itemOrder,
    props.state.activeTurnId,
    props.state.conversationState,
    props.state.queue,
    props.state.pendingRequests,
    props.state.planImplementationRequests,
    props.state.terminalTurnIds,
    props.state.turnsByProviderId,
    props.state.snapshot?.snapshotV2,
    props.historyOnly,
    props.projectPersistedPlans,
    props.creationStatus,
  ];
  const contentProjection = updateTranscriptProjection(previousProjection.current, props.state, projectionContext);
  const persistedItems = useMemo(
    () =>
      contentProjection?.items ??
      coalesceTranscriptUserMessages(
        props.state.itemOrder
          .map((key) => props.state.items[key])
          .filter(
            (entry): entry is NativeSessionItemBuffer =>
              Boolean(entry) &&
              (!props.historyOnly || !entry.optimistic) &&
              isVisibleTranscriptItem(entry) &&
              isFormalPlanTranscriptItem(entry, props.state) &&
              !isComposerQueuedUserItem(entry, composerQueueSubmissionIds, composerQueueClientUserMessageIds),
          ),
      ),
    [composerQueueClientUserMessageIds, composerQueueSubmissionIds, props.historyOnly, props.state.activeTurnId, props.state.itemOrder, props.state.items, props.state.planImplementationRequests],
  );
  const queuedSubmissionItems = useMemo(() => projectQueuedSubmissionItems(props.state, transcriptQueuedSubmissions, persistedItems), [persistedItems, props.state.conversationId, props.state.providerThreadId, transcriptQueuedSubmissions]);
  const projectedItems = useMemo(() => {
    if (contentProjection) return contentProjection.items;
    // 已确认消息沿用历史时间；仍在排队的补充留在记录末尾，避免切换后藏到旧回复上方。
    const durableItems = [...persistedItems, ...queuedSubmissionItems];
    return orderTranscriptItemsWithQueue(props.projectPersistedPlans ? projectPersistedTurnPlans(props.state, durableItems) : durableItems, props.state.queue);
  }, [
    persistedItems,
    props.projectPersistedPlans,
    props.state.conversationId,
    props.state.planImplementationRequests,
    props.state.providerThreadId,
    props.state.queue,
    props.state.snapshot?.snapshotV2,
    props.state.terminalTurnIds,
    props.state.turnsByProviderId,
    queuedSubmissionItems,
  ]);
  const collapsedErrorItems = useMemo(() => contentProjection?.items ?? collapseRepeatedErrorItems(projectedItems), [projectedItems]);
  const transcriptItems = useMemo(
    () =>
      contentProjection?.items ??
      collapsedErrorItems.filter((item) => {
        const turn = props.state.turnsByProviderId[item.turnId];
        // 轮次失败卡片已经承载底层原因时，不再把同一诊断事件单独画成第二张红卡。
        if (itemRole(item) === 'error' && turn?.status === 'failed' && turn.error) return false;
        // rollout 恢复项只承担缺失 server request 时的内容展示。真实请求一旦到达，
        // 无论仍在等待还是已经回答，都由带当前世代权限的请求投影接管。
        if (isRecoveredRequestUserInputItem(item) && props.state.pendingRequests.some((request) => authoritativeRequestMatchesRecoveredItem(request, item))) return false;
        return true;
      }),
    [collapsedErrorItems, props.state.pendingRequests, props.state.turnsByProviderId],
  );
  // 原始思考摘要完整保留在会话状态中；会话记录的当前态选择统一交给行投影处理。
  const items = transcriptItems;
  const historyHydrated = props.transcriptHydrated ?? props.state.snapshot !== null;
  const enteringItemIds = useNewItemMotionIds(
    items.map((item) => item.key),
    newItemMotionDurationMs,
    historyHydrated,
    props.state.transcriptLiveItemKeys ?? [],
  );
  /** 输入样式也承载智能体来信，不能把后台来信当作当前用户发送。 */
  const lastUserItem = [...items].reverse().find((entry) => `${entry.type}`.toLocaleLowerCase().includes('user'));
  /** 可见输入身份仍用于消息样式和动画。 */
  const lastUserKey = lastUserItem?.key;
  /** 远程指令沿用当前滚动模式，保留静态阅读位置。 */
  const lastInputFromAgent = Boolean(lastUserItem?.payload.subagentInput);
  const answeredRequests = useMemo(() => props.state.pendingRequests.filter(isAnsweredUserInputRequest), [props.state.pendingRequests]);
  // 当前状态始终读取完整会话事件，不受活动列表的展示筛选影响。
  const activeStatusKind = transcriptRunStatus(props.state);
  /** Codex 摘要与 Pi thinking/reasoning 共用当前进展位置，不按供应商或模型名称分支。 */
  const activeReasoningItem = useMemo(() => latestActiveReasoningSummaryItem(items, activeTurnId), [activeTurnId, items]);
  // 创建中的会话尚未建立真实轮次时，由连接提示承担当前进度。
  const creatingSession = props.creationStatus?.state === 'creating' || props.creationStatus?.state === 'retrying';
  // 创建失败时保留创建错误，不再显示独立运行状态。
  const creationFailed = props.creationStatus?.state === 'failed';
  // 本地创建工作面使用合成轮次保持可交互；只有权威快照里的轮次才能接管创建进度。
  const realTurnStarted = Boolean(activeTurnId && props.state.snapshot);
  // 创建期只保留一个主进度：真实轮次建立前显示连接，建立后由轮次状态或真实过程内容接管。
  const showCreationStatus = Boolean(props.creationStatus) && !(creatingSession && realTurnStarted);
  // 只有实际渲染的底部状态可以接管过程中的整理提示。
  const showStandaloneActiveStatus = !props.historyOnly && Boolean(activeStatusKind) && !creationFailed && !(creatingSession && !realTurnStarted);
  // 只筛选底部已承载的同轮进行中整理；完成、失败、历史及其他活动继续参与原有投影。
  const transcriptRows = useMemo(() => {
    if (contentProjection) return contentProjection.rows;
    // 此列表仅用于生成可见行，原始条目及身份不做删除或合并。
    const visibleItems =
      showStandaloneActiveStatus && activeStatusKind === 'compacting' ? items.filter((item) => item.turnId !== activeTurnId || normalizeItemType(item.type) !== 'contextcompaction' || item.status !== 'in_progress') : items;
    return reuseTranscriptRows(previousProjection.current?.rows ?? [], projectTranscriptRows(visibleItems, answeredRequests, activeTurnId, props.historyOnly, props.state.terminalTurnIds));
  }, [activeStatusKind, activeTurnId, answeredRequests, items, props.historyOnly, props.state.terminalTurnIds, showStandaloneActiveStatus]);
  const processAvailableTurnIds = useMemo(() => availableTurnProcessIds(props.state.snapshot), [props.state.snapshot?.snapshotV2]);
  const closedTurnChangeSetIds = useMemo(() => availableClosedTurnChangeSetIds(props.state.snapshot), [props.state.snapshot?.snapshotV2]);
  const baseTurnRows = useMemo(
    () => contentProjection?.turnRows ?? reuseTranscriptTurnRows(previousProjection.current?.turnRows ?? [], projectTranscriptTurnRows(transcriptRows, activeTurnId, props.state.terminalTurnIds, processAvailableTurnIds)),
    [activeTurnId, processAvailableTurnIds, props.state.terminalTurnIds, transcriptRows],
  );
  previousProjection.current = contentProjection ?? createTranscriptProjection(props.state, projectionContext, items, transcriptRows, baseTurnRows);

  /** 目录只在稳定身份、送达状态、轮次结束或连接变化时重新读取。 */
  const latestNavigationUser = props.state.items[lastUserKey ?? ''];
  /** 前插历史不触发完整目录重读，只观察最新发言的确认状态。 */
  const navigationRefreshKey = `${props.state.transportState}:${latestNavigationUser?.clientUserMessageId ?? latestNavigationUser?.itemId ?? ''}:${latestNavigationUser?.optimistic ? latestNavigationUser.status : 'confirmed'}:${Object.entries(
    props.state.terminalTurnIds,
  )
    .map(([id, status]) => `${id}:${status}`)
    .join('|')}:${answeredRequests.map((request) => `${request.id}:${request.resolvedAt}`).join('|')}`;
  /** 完整目录与首屏正文并行取得，绝不要求用户先滚到更早历史。 */
  const navigation = useConversationNavigation({ scopeKey: props.state.conversationId, refreshKey: navigationRefreshKey, load: props.onLoadNavigation });
  /** 真实投影提供已加载身份，目录只补齐缺失历史。 */
  const liveNavigationEntries = useMemo(() => transcriptNavigationEntries(baseTurnRows, props.state), [baseTurnRows, props.state.turnsByProviderId, props.state.terminalTurnIds]);
  /** 摘录不变时复用目录，流式长正文不会反复刷新全部刻度。 */
  const previousNavigationEntriesRef = useRef<TranscriptNavigationEntry[]>([]);
  /** 目录与实时发送按稳定身份合并。 */
  const navigationEntries = useMemo(() => {
    /** 所有成员均为标量字段，字段比较不读取正文。 */
    const next = mergeNavigationEntries(navigation.snapshot?.entries ?? [], liveNavigationEntries);
    /** 保持旧对象以隔离刻度与正文的刷新频率。 */
    const previous = previousNavigationEntriesRef.current;
    if (next.length === previous.length && next.every((entry, index) => Object.keys(entry).every((key) => entry[key as keyof TranscriptNavigationEntry] === previous[index]?.[key as keyof TranscriptNavigationEntry]))) return previous;
    previousNavigationEntriesRef.current = next;
    return next;
  }, [navigation.snapshot, liveNavigationEntries]);
  /** 普通发言和已提交答题卡合计至少两次互动才显示刻度，单次互动保留原生滚动。 */
  const showNavigation = Boolean(props.onLoadNavigation && navigation.snapshot && navigationEntries.length > 1);
  /** 失败记录与历史占位一同进入时间线，后续发言不能越过已发生的错误。 */
  const turnRows = useMemo(
    () => projectTranscriptFailureRows(props.onLoadNavigation ? projectNavigationRows(baseTurnRows, navigationEntries) : baseTurnRows, props.state.turnsByProviderId),
    [baseTurnRows, navigationEntries, props.onLoadNavigation, props.state.turnsByProviderId],
  );
  /** 任意正文行映射到其前方最近一次用户发言，长回答内滚动也能维持当前刻度。 */
  const navigationKeyByRow = useMemo(() => {
    /** 目录身份同时标记已加载行与未加载占位。 */
    const keys = new Set(navigationEntries.map((entry) => entry.rowKey));
    /** 按正文顺序仅构建一次映射，滚动时不用遍历完整历史。 */
    const result = new Map<string, string>();
    /** 首屏可能从某轮回答中途开始，默认对应目录首项。 */
    let current = navigationEntries[0]?.rowKey;
    for (const row of turnRows) {
      if (keys.has(row.key)) current = row.key;
      if (current) result.set(row.key, current);
      /** 过程之后的答复对应其中最后一张答题卡。 */
      if (row.kind === 'turn_work') current = navigationEntries.filter((entry) => entry.parentRowKey === row.key).at(-1)?.rowKey ?? current;
    }
    return result;
  }, [turnRows, navigationEntries]);
  const defaultExpandedRowKeys = useMemo(() => defaultExpandedTurnProcessKeys(baseTurnRows, props.state.turnsByProviderId, props.state.terminalTurnIds), [props.state.terminalTurnIds, props.state.turnsByProviderId, baseTurnRows]);
  const expandedRowKeys = useMemo(() => {
    const expanded = new Set(defaultExpandedRowKeys);
    for (const [rowKey, open] of rowExpansionOverrides) {
      if (open) expanded.add(rowKey);
      else expanded.delete(rowKey);
    }
    return expanded;
  }, [defaultExpandedRowKeys, rowExpansionOverrides]);
  /** 文本变化不重建虚拟窗口键数组。 */
  const previousTurnRowKeys = useRef<string[]>([]);
  const turnRowKeys = useMemo(() => {
    const previous = previousTurnRowKeys.current;
    if (previous.length === turnRows.length && turnRows.every((row, index) => row.key === previous[index])) return previous;
    return (previousTurnRowKeys.current = turnRows.map((row) => row.key));
  }, [turnRows]);
  const turnRowsByKey = useMemo(() => new Map(turnRows.map((row) => [row.key, row])), [turnRows]);
  const activeTurnRowKeys = useMemo(() => new Set(turnRows.filter((row) => activeTurnId && transcriptTurnRowTurnId(row) === activeTurnId).map((row) => row.key)), [activeTurnId, turnRows]);
  const pinnedRowKeys = useMemo(() => {
    const pinned = new Set([...activeTurnRowKeys, ...expandedRowKeys]);
    if (focusedRowKey) pinned.add(focusedRowKey);
    if (historyAnchorRowKey) pinned.add(historyAnchorRowKey);
    if (staticReadingAnchorRowKey) pinned.add(staticReadingAnchorRowKey);
    if (navigationTargetKey) pinned.add(navigationEntries.find((entry) => entry.rowKey === navigationTargetKey)?.parentRowKey ?? navigationTargetKey);
    return pinned;
  }, [activeTurnRowKeys, expandedRowKeys, focusedRowKey, historyAnchorRowKey, staticReadingAnchorRowKey, navigationTargetKey, navigationEntries]);
  const isFollowingLatest = useCallback(() => scrollController.getState().mode !== 'static', [scrollController]);
  const requestLatestPositionAfterGeometryChange = useCallback(() => maintainLatestPositionRef.current(), []);
  /** 仅在测量缓存命中时检查短布局元数据，正文不参与序列化。 */
  const rowLayoutSignature = useCallback(
    (key: string): string => {
      const row = turnRowsByKey.get(key);
      if (!row) return 'absent';
      const rows = row.kind === 'turn_work' ? row.segments.flatMap((segment) => [...(segment.summary ? [segment.summary] : []), ...segment.rows]) : [row];
      let revision = 0;
      let length = 0;
      for (const child of rows) {
        const contents = child.kind === 'item' ? [child.item] : child.kind === 'activity' ? child.items : [];
        for (const item of contents) {
          length += item.text.length;
          for (const source of item.transcript?.sources ?? []) revision = Math.max(revision, source.contentRevision);
        }
      }
      return `${revision}:${length}:${rows.length}:${expandedRowKeys.has(turnProcessExpansionKey(row.kind === 'turn_work' ? row.key : row.kind === 'item' ? row.item.turnId : key))}`;
    },
    [turnRowsByKey, expandedRowKeys],
  );
  const viewportVirtualizer = useTranscriptViewportVirtualizer({
    scopeKey: props.state.conversationId,
    rowKeys: turnRowKeys,
    rowLayoutSignature,
    pinnedRowKeys,
    containerRef,
    isFollowingLatest,
    getReadingAnchor: getStaticReadingAnchor,
    onFollowingLatestGeometryChange: requestLatestPositionAfterGeometryChange,
    suspendAutomaticAnchor: historyAnchorRowKey !== null,
  });
  const synchronizeTranscriptViewport = viewportVirtualizer.synchronizeViewport;
  const positionLatest = useCallback(
    (container: HTMLElement): void => {
      scrollToLatest(container, latestContentMarkerRef.current);
      // scrollTop 可能已被浏览器随高度变化钳制到同一数值，此时不会再产生 scroll 事件。
      // 程序化贴底必须同时刷新虚拟窗口，不能等用户滚轮来补这次投影。
      synchronizeTranscriptViewport(container);
    },
    [synchronizeTranscriptViewport],
  );
  /** 整轮耗时和当前阶段只由最后一段过程呈现，避免插话分段后重复提示。 */
  const projectedTurnWorkKeyByTurn = useMemo(() => new Map(turnRows.filter((row): row is TranscriptTurnWorkRow => row.kind === 'turn_work').map((row) => [row.turnId, row.key])), [turnRows]);
  const completionAnchorKeyByTurn = useMemo(() => turnArtifactAnchorKeyByTurn(transcriptRows), [transcriptRows]);
  /** 耗时入口优先锚定最终正文；资源交付仍沿用原有的轮次收尾位置。 */
  const turnSummaryAnchorKeyByTurn = useMemo(() => {
    /** 没有最终正文的轮次保留计划、图片或最后记录作为展示位置。 */
    const anchors = { ...completionAnchorKeyByTurn };
    for (const row of transcriptRows) {
      if (row.kind === 'item' && isFinalAnswerItem(row.item)) anchors[row.item.turnId] = row.item.key;
    }
    return anchors;
  }, [completionAnchorKeyByTurn, transcriptRows]);
  const showActiveStatus = !props.historyOnly && shouldShowTranscriptThinking(props.state, items);
  const motionFocus = props.historyOnly ? null : resolveSessionMotionFocus(props.state, transcriptItems, showActiveStatus);
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
    onLoadEarlierHistory: useStableOptionalCallback(props.onLoadEarlierHistory),
    onLoadTurnProcess: useStableOptionalCallback(props.onLoadTurnProcess),
    onLoadConversationResources: useStableOptionalCallback(props.onLoadConversationResources),
    onLoadTurnArtifacts: useStableOptionalCallback(props.onLoadTurnArtifacts),
    onLoadV2Content: useStableOptionalCallback(props.onLoadV2Content),
    onLoadV2ToolResult: useStableOptionalCallback(props.onLoadV2ToolResult),
    onReconnectCodex: useStableOptionalCallback(props.onReconnectCodex),
    onRetryQueuedSubmission: useStableOptionalCallback(props.onRetryQueuedSubmission),
  };
  const itemsNeedingInlineResources = useMemo(() => items.filter(itemNeedsInlineResources), [items]);
  const resourcePaging = props.state.snapshot?.v2Paging?.resources;
  /** 仅资源状态变化才通知图片节点，不随正文流式渲染重新创建上下文。 */
  const imageResourceContext = useMemo(
    () => ({
      state: resourcePaging?.error
        ? ('failed' as const)
        : (resourcePaging && (!resourcePaging.loaded || resourcePaging.loading || resourcePaging.hasMore)) || props.state.transportState !== 'ready'
          ? ('loading' as const)
          : ('ready' as const),
      reload: renderProps.onLoadConversationResources,
    }),
    [resourcePaging?.error, resourcePaging?.loaded, resourcePaging?.loading, resourcePaging?.hasMore, props.state.transportState, renderProps.onLoadConversationResources],
  );
  /** 完整链接、权威身份和完成状态决定补载；正文逐字变化不会触发循环请求。 */
  const inlineResourceSignature = useMemo(
    () => inlineResourceRequestSignature(itemsNeedingInlineResources.map((item) => ({ key: item.key, turnId: item.turnId, providerItemId: item.providerItemId, status: item.status, text: transcriptItemText(item) }))),
    [itemsNeedingInlineResources],
  );
  const assistantDeliverablesAvailable = Boolean(props.state.snapshot?.snapshotV2?.collections.resources.assistantDeliverablesAvailable);
  useEffect(() => {
    const loadTurnArtifacts = renderProps.onLoadTurnArtifacts;
    if (props.state.transportState !== 'ready' || !loadTurnArtifacts) return;
    // 最近完成轮次彼此独立；较旧轮次或会话资源较慢时，不能挡住当前轮文件卡。
    void Promise.allSettled(closedTurnChangeSetIds.map(loadTurnArtifacts));
  }, [closedTurnChangeSetIds, props.state.conversationId, props.state.transportState, renderProps.onLoadTurnArtifacts]);
  useEffect(() => {
    const loadTurnArtifacts = renderProps.onLoadTurnArtifacts;
    const loadConversationResources =
      renderProps.onLoadConversationResources ?? (itemsNeedingInlineResources.length && loadTurnArtifacts ? () => Promise.all([...new Set(itemsNeedingInlineResources.map((item) => item.turnId))].map(loadTurnArtifacts)) : undefined);
    const assistantDeliverablesNeedLoading = Boolean(assistantDeliverablesAvailable && resourcePaging && (!resourcePaging.loaded || resourcePaging.hasMore));
    // 资源补齐后解除本次尝试锁。若后续权威快照异常丢失展示资源，可再次自愈；
    // 真正失败且状态未变化时仍保留尝试键，避免无界重试。
    if (!itemsNeedingInlineResources.length && !assistantDeliverablesNeedLoading) {
      automaticResourceLoadAttemptRef.current = null;
      return;
    }
    // 渐进水合会先投影可读正文，再发布完整交互快照。若在 hydrating 阶段读取，
    // 连接代次切换会丢弃该页且相同正文不会再触发一次；必须等权威水合完成。
    if (props.state.transportState !== 'ready' || !loadConversationResources || !resourcePaging || resourcePaging.loading) return;
    // 正文取得权威身份或进入终态后允许补齐迟到资源；资源页返回本身不触发重复读取。
    const attemptKey = `${props.state.conversationId}:${assistantDeliverablesAvailable ? 'assistant-deliverables' : 'ordinary-resources'}:${inlineResourceSignature}`;
    if (automaticResourceLoadAttemptRef.current === attemptKey) return;
    automaticResourceLoadAttemptRef.current = attemptKey;
    // Markdown 链接、图片和已持久用户附件都属于正文，不应要求用户先展开“处理过程”
    // 才能取得资源元数据。
    // 失败保留现有占位与手动重试入口，避免 React 重渲染形成无界请求循环。
    void Promise.resolve(loadConversationResources()).catch(() => undefined);
  }, [assistantDeliverablesAvailable, inlineResourceSignature, itemsNeedingInlineResources, props.state.conversationId, props.state.transportState, renderProps.onLoadConversationResources, renderProps.onLoadTurnArtifacts, resourcePaging]);
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

  /** 只读取已经挂载的可见行，当前刻度变化才刷新状态。 */
  const updateNavigationCurrent = useCallback(
    (container: HTMLElement) => {
      if (!props.onLoadNavigation) return;
      /** 此读取复用正文已有的视口锚点规则，最多检查虚拟窗口内的行。 */
      const rowKey = captureTranscriptViewportAnchor(container).rowKey;
      /** 底部留白仍属于最后一次发言。 */
      let next = rowKey ? (navigationKeyByRow.get(rowKey) ?? null) : (navigationEntries.at(-1)?.rowKey ?? null);
      /** 展开的过程只检查当前已挂载卡片，滚动时同步对应刻度。 */
      for (const child of container.querySelectorAll<HTMLElement>('[data-navigation-row-key]')) {
        if (child.closest<HTMLElement>('[data-transcript-row-key]')?.dataset.transcriptRowKey !== rowKey) continue;
        if (child.getBoundingClientRect().top > container.getBoundingClientRect().top + 25) break;
        if (navigationEntries.some((entry) => entry.rowKey === child.dataset.navigationRowKey)) next = child.dataset.navigationRowKey!;
      }
      setActiveNavigationKey((current) => (current === next ? current : next));
    },
    [navigationEntries, navigationKeyByRow, props.onLoadNavigation],
  );

  /** 导航显式进入历史阅读，先挂载目标行，再由布局阶段定位。 */
  const navigateToEntry = useCallback(
    (entry: TranscriptNavigationEntry) => {
      scrollController.onExplicitHistoryRequest();
      // 目录可先于首屏正文返回；显式跳转接管首次定位，后到的正文不得拉回最新。
      positionedConversationIdRef.current = props.state.conversationId;
      clearUserScrollIntent();
      clearStaticReadingAnchor();
      setNavigationReadError(null);
      setNavigationTargetKey(entry.rowKey);
      /** 历史卡片仍留在处理过程里；明确导航时才展开所属过程。 */
      const processKey = turnProcessExpansionKey(entry.parentRowKey ?? `turn-work:${encodeURIComponent(entry.providerTurnId ?? entry.turnId)}`);
      setRowExpansionOverrides((previous) => new Map(previous).set(processKey, true));
      setActiveNavigationKey(entry.rowKey);
      setReturnToLatestVisible(true);
      /** 请求只服务当前跳转，旧回执不影响后来的点击。 */
      const request = ++navigationRequestRef.current;
      // 显式跳转立即读取目标轮次，不等待虚拟占位进入观察区域；控制器会合并并发请求。
      if (props.onLoadNavigationTurn)
        void props.onLoadNavigationTurn(entry.turnId).catch((error: unknown) => {
          if (request === navigationRequestRef.current) setNavigationReadError({ entry, message: error instanceof Error ? error.message : '正文读取失败。' });
        });
    },
    [scrollController, clearUserScrollIntent, clearStaticReadingAnchor, props.onLoadNavigationTurn, props.state.conversationId],
  );

  useLayoutEffect(() => {
    /** pinnedRowKeys 确保远处目标可以先挂载，再使用实际高度定位。 */
    const container = containerRef.current;
    if (!container || !navigationTargetKey) return;
    /** 占位替换为真实用户消息时沿用同一行身份。 */
    const entry = navigationEntries.find((candidate) => candidate.rowKey === navigationTargetKey);
    /** 未加载目录先保留目标，真实卡片挂载后才完成定位。 */
    const parentKey = entry?.parentRowKey ?? navigationTargetKey;
    const parent = viewportVirtualizer.rowElement(parentKey);
    const target = entry?.parentRowKey ? parent?.querySelector<HTMLElement>(`[data-navigation-row-key="${CSS.escape(navigationTargetKey)}"]`) : parent;
    if (!target || !parent || !entry?.loaded) return;
    container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
    staticReadingAnchorRef.current = {
      itemKey: target.closest<HTMLElement>('[data-transcript-item-key]')?.dataset.transcriptItemKey ?? null,
      rowKey: parentKey,
      topOffset: parent.getBoundingClientRect().top - container.getBoundingClientRect().top,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
    };
    setStaticReadingAnchorRowKey(parentKey);
    setNavigationTargetKey(null);
    viewportVirtualizer.synchronizeViewport(container);
    scheduleLatestContentVisibility();
  }, [navigationTargetKey, navigationEntries, expandedRowKeys, viewportVirtualizer.projection, scheduleLatestContentVisibility]);

  useLayoutEffect(() => {
    if (containerRef.current) updateNavigationCurrent(containerRef.current);
  }, [viewportVirtualizer.projection, updateNavigationCurrent]);

  useEffect(() => {
    navigationRequestRef.current += 1;
    setNavigationTargetKey(null);
    setNavigationReadError(null);
    return () => {
      navigationRequestRef.current += 1;
    };
  }, [props.state.conversationId]);

  const maintainLatestPosition = useCallback(() => {
    latestPositionConvergenceRequestedRef.current = true;
    if (latestPositionFrameRef.current !== null || latestPositionFallbackTimerRef.current !== null) return;
    let pass = 0;
    let stableFrames = 0;
    let previousGeometry = '';
    const schedulePass = (): void => {
      let handled = false;
      const run = (): void => {
        if (handled) return;
        handled = true;
        if (latestPositionFrameRef.current !== null && latestPositionFrameRef.current >= 0) cancelAnimationFrame(latestPositionFrameRef.current);
        if (latestPositionFallbackTimerRef.current) clearTimeout(latestPositionFallbackTimerRef.current);
        latestPositionFallbackTimerRef.current = null;
        converge();
      };
      latestPositionFrameRef.current = requestAnimationFrame(run);
      // Electron 窗口被系统短暂遮挡时 rAF 可能暂停；恢复前仍以低频后备任务
      // 收敛 scrollTop，避免再次显示窗口时停留在旧的最大滚动位置。
      latestPositionFallbackTimerRef.current = setTimeout(run, latestPositionFallbackMs);
    };
    const converge = (): void => {
      // rAF 已经开始执行，但在本轮决策结束前仍保持“有任务”，让同时到达的
      // ResizeObserver/投影回调只标记 dirty，而不是并发创建第二条循环。
      latestPositionFrameRef.current = -1;
      const container = containerRef.current;
      if (!container) {
        latestPositionFrameRef.current = null;
        latestPositionConvergenceRequestedRef.current = false;
        return;
      }
      // 用户滚动先于浏览器 scroll 事件到达；此时继续贴底会抵消原生位移，
      // 使离底距离始终无法越过历史阅读门槛。意图结束后仅跟随态会重新收敛。
      if (userScrollIntentRef.current) {
        latestPositionFrameRef.current = null;
        latestPositionConvergenceRequestedRef.current = false;
        return;
      }
      const effect = scrollController.onDelta();
      if (effect.type !== 'scroll_to_bottom') {
        latestPositionFrameRef.current = null;
        latestPositionConvergenceRequestedRef.current = false;
        scheduleLatestContentVisibility();
        return;
      }
      const externallyRequested = latestPositionConvergenceRequestedRef.current;
      latestPositionConvergenceRequestedRef.current = false;
      positionLatest(container);
      setReturnToLatestVisible(false);
      scheduleLatestContentVisibility();
      const current = metrics(container);
      const geometry = `${Math.round(current.scrollHeight)}:${Math.round(current.clientHeight)}:${Math.round(current.scrollTop)}`;
      const atBottom = current.scrollHeight - current.clientHeight - current.scrollTop <= 1;
      stableFrames = atBottom && geometry === previousGeometry && !externallyRequested ? stableFrames + 1 : 0;
      previousGeometry = geometry;
      pass += 1;
      if (pass < 12 && (stableFrames < 2 || latestPositionConvergenceRequestedRef.current)) {
        schedulePass();
        return;
      }
      latestPositionFrameRef.current = null;
      latestPositionConvergenceRequestedRef.current = false;
    };
    schedulePass();
  }, [positionLatest, scheduleLatestContentVisibility, scrollController]);
  maintainLatestPositionRef.current = maintainLatestPosition;

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
        // 活动状态收起、Markdown 完成布局等变化可能只移动底部标记，既不改变
        // 固定高度滚动容器的 border box，也不保证产生可观察的正文 DOM 变更。
        // 跟随态下标记一旦离开视口，就必须重新唤醒统一贴底调度器；历史阅读态
        // 仍由 controller 门禁，不会被 IntersectionObserver 接管。
        if (isFollowingLatest()) maintainLatestPosition();
        scheduleLatestContentVisibility();
      },
      { root: container, threshold: 0 },
    );
    observer.observe(marker);
    scheduleLatestContentVisibility();
    return () => observer.disconnect();
  }, [isFollowingLatest, maintainLatestPosition, scheduleLatestContentVisibility]);

  useEffect(() => {
    window.addEventListener('pointerup', finishUserScrollPointerIntent);
    window.addEventListener('pointercancel', finishUserScrollPointerIntent);
    return () => {
      window.removeEventListener('pointerup', finishUserScrollPointerIntent);
      window.removeEventListener('pointercancel', finishUserScrollPointerIntent);
    };
  }, [finishUserScrollPointerIntent]);

  useEffect(
    () => () => {
      if (latestPositionFrameRef.current !== null && latestPositionFrameRef.current >= 0) cancelAnimationFrame(latestPositionFrameRef.current);
      if (latestPositionFallbackTimerRef.current) clearTimeout(latestPositionFallbackTimerRef.current);
      if (latestVisibilityFrameRef.current !== null) cancelAnimationFrame(latestVisibilityFrameRef.current);
      if (userScrollIntentTimerRef.current) clearTimeout(userScrollIntentTimerRef.current);
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
    clearUserScrollIntent();
    clearStaticReadingAnchor();
    const effect = scrollController.onExplicitLatestRequest();
    if (effect.type === 'scroll_to_bottom') positionLatest(container);
    maintainLatestPosition();
    setReturnToLatestVisible(false);
    setHistoryPagingGate({ conversationId, positioned: true, userIntent: false });
    setHistoryPagingRequestedConversationId(null);
    setHistorySentinelIntersection({ conversationId, intersecting: false });
  }, [clearStaticReadingAnchor, clearUserScrollIntent, historyHydrated, maintainLatestPosition, positionLatest, props.state.conversationId, props.state.transcriptRevision, scrollController]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const conversationId = props.state.conversationId;
    const revision = props.localSubmissionRevision ?? 0;
    const tracked = trackedLocalSubmissionRef.current;
    if (!conversationId || tracked.conversationId !== conversationId) {
      trackedLocalSubmissionRef.current = { conversationId, revision };
      return;
    }
    if (!container || revision <= tracked.revision) return;
    tracked.revision = revision;
    clearUserScrollIntent();
    clearStaticReadingAnchor();
    const effect = scrollController.onMessageSubmitted();
    if (effect.type === 'scroll_to_bottom') {
      positionLatest(container);
      setReturnToLatestVisible(false);
      maintainLatestPosition();
    }
  }, [clearStaticReadingAnchor, clearUserScrollIntent, maintainLatestPosition, positionLatest, props.localSubmissionRevision, props.state.conversationId, scrollController]);

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
    clearUserScrollIntent();
    clearStaticReadingAnchor();
    const effect = scrollController.onMessageSubmitted();
    if (effect.type === 'scroll_to_bottom') {
      positionLatest(container);
      setReturnToLatestVisible(false);
      maintainLatestPosition();
    }
  }, [awaitingReplyMessageIds, clearStaticReadingAnchor, clearUserScrollIntent, historyHydrated, maintainLatestPosition, positionLatest, props.state.conversationId, scrollController]);

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
    if (!lastUserKey || lastUserKey === previousKey || lastInputFromAgent) return;

    // 以可见用户消息身份作为发送锚点，覆盖“发送后很快被 accepted/完成，来不及进入 awaitingReply 列表”的快速路径。
    clearUserScrollIntent();
    clearStaticReadingAnchor();
    const effect = scrollController.onMessageSubmitted();
    if (effect.type === 'scroll_to_bottom') {
      positionLatest(container);
      setReturnToLatestVisible(false);
      maintainLatestPosition();
    }
  }, [clearStaticReadingAnchor, clearUserScrollIntent, historyHydrated, lastInputFromAgent, lastUserKey, maintainLatestPosition, positionLatest, props.state.conversationId, scrollController]);

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
      const effect = scrollController.onTurnStarted();
      if (effect.type === 'scroll_to_bottom') {
        positionLatest(container);
        setReturnToLatestVisible(false);
        maintainLatestPosition();
      }
    }
    previousTurnIdRef.current = activeTurnId;
  }, [activeTurnId, historyHydrated, latestSubmittedMessageId, maintainLatestPosition, positionLatest, scrollController]);

  useLayoutEffect(() => {
    maintainLatestPosition();
  }, [maintainLatestPosition, props.creationStatus?.error, props.creationStatus?.state, props.state.transcriptRevision]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !historyHydrated || typeof MutationObserver !== 'function') return;
    // 会话切换时，快照行可以先以稳定 key 进入虚拟窗口，Markdown 再在后续
    // 微任务中补入正文。此时 transcriptRevision、行 key 和初次尺寸都可能不变，
    // 仅靠 React effect / ResizeObserver 会漏掉这次内容水合。DOM 正文变化只负责
    // 唤醒统一的按帧调度器；是否贴底仍由 scroll controller 的两态决定。
    const observer = new MutationObserver(() => maintainLatestPosition());
    observer.observe(container, { childList: true, characterData: true, subtree: true });
    maintainLatestPosition();
    return () => observer.disconnect();
  }, [historyHydrated, maintainLatestPosition, props.state.conversationId]);

  /** 用户主动展开过程时进入静态阅读，避免内容增高后的自动贴底移动入口。 */
  const setTranscriptRowExpanded = useCallback(
    (rowKey: string, open: boolean, trigger: HTMLButtonElement): void => {
      if (containerRef.current) {
        scrollController.onExplicitHistoryRequest();
        rememberStaticReadingAnchor(containerRef.current);
        pendingProcessAnchorRef.current = { trigger, top: trigger.getBoundingClientRect().top };
        setReturnToLatestVisible(true);
      }
      setRowExpansionOverrides((current) => {
        if (current.get(rowKey) === open) return current;
        const next = new Map(current);
        next.set(rowKey, open);
        return next;
      });
    },
    [rememberStaticReadingAnchor, scrollController],
  );

  useLayoutEffect(() => {
    /** 只处理用户刚刚切换的过程入口，后续异步增高继续交给虚拟列表锚点。 */
    const pendingAnchor = pendingProcessAnchorRef.current;
    /** 会话切换或卸载期间不再补偿旧容器。 */
    const container = containerRef.current;
    if (!pendingAnchor || !container) return;
    pendingProcessAnchorRef.current = null;
    if (pendingAnchor.trigger.isConnected) container.scrollTop += pendingAnchor.trigger.getBoundingClientRect().top - pendingAnchor.top;
    synchronizeTranscriptViewport(container);
  }, [expandedRowKeys, synchronizeTranscriptViewport]);

  const renderTranscriptTurnRow = (row: TranscriptViewportRow): ReactNode => {
    if (row.kind === 'turn_failure') {
      /** 后台仍在核对本轮时只显示统一运行状态，避免错误卡和重连状态同时闪烁。 */
      const recovering = props.state.providerReconnectTurnId === row.turnId && props.state.providerReconnectAttempt > 0;
      if (recovering) return null;
      return <TurnFailureCard failure={row.failure} language={props.language} retainedAnswer={turnHasRetainedAssistantAnswer(items, row.turnId)} />;
    }
    if (row.kind === 'navigation_placeholder') return <NavigationHistoryPlaceholder entry={row.entry} language={props.language} onLoad={historyHydrated ? props.onLoadNavigationTurn : undefined} />;
    if (row.kind === 'answered_request') return <AnsweredRequestHistory request={row.request} language={props.language} />;
    if (row.kind === 'turn_work') {
      const turn = props.state.turnsByProviderId[row.turnId];
      /** 过程沿已有分页范围补齐，展开本身不改变读取方向。 */
      const processPaging = turnDetailPaging(props.state.snapshot, turn?.providerTurnId ?? row.turnId);
      /** 只有首次读取时，正常完成态优先从头阅读。 */
      const turnCompleted = props.state.terminalTurnIds[row.turnId] === 'completed' || turn?.status === 'completed';
      /** 倒序读取时，自动补页边界放在已读过程之前。 */
      const earlierProcess = processPaging?.direction === 'tail';
      /** 只在展开后滚动到缺页边界时补读，避免一次读完整个长轮次。 */
      const pageSentinel =
        row.loadMore && processPaging && ((processPaging.loaded && processPaging.hasMore) || processPaging.error) && renderProps.onLoadTurnProcess ? (
          <TurnProcessPageSentinel enabled={expandedRowKeys.has(turnProcessExpansionKey(row.key))} paging={processPaging} turnId={row.turnId} onLoad={renderProps.onLoadTurnProcess} />
        ) : null;
      const expansionKey = turnProcessExpansionKey(row.key);
      const containsCompletionAnchor = row.segments.some(
        (segment) =>
          Boolean(segment.summary && transcriptRowContainsItemKey(segment.summary, completionAnchorKeyByTurn[row.turnId])) || segment.rows.some((child) => transcriptRowContainsItemKey(child, completionAnchorKeyByTurn[row.turnId])),
      );
      /** 缺少轮次快照时沿用过程行自身的实时状态。 */
      const turnActive = turn ? isActiveSessionTurn(turn) : row.live;
      /** 只有当前输入所属的活动轮次显示外置进展。 */
      const processLive = row.live && turnActive;
      /** 逐段进展使用真实操作数量；最终正文可见后的整轮入口改用实际用时。 */
      const processActivityCount = turnProcessActivityCount(row.segments);
      /** 过程展开后保留原始顺序；完成轮次的中途说明也在这里回看。 */
      const renderProcessSegments = (active: boolean): ReactNode =>
        row.segments.map((segment, segmentIndex) => {
          /** 阶段说明属于过程内容，模型回复正文始终独立显示。 */
          const summary = segment.summary;
          /** 完成后包含中途说明，运行中只包含思考与操作明细。 */
          const rows = segment.rows;
          if (!summary && rows.length === 0) return null;
          return (
            <section className="session-turn-process-stage" data-current={row.live && projectedTurnWorkKeyByTurn.get(row.turnId) === row.key && segmentIndex === row.segments.length - 1 ? true : undefined} key={segment.key}>
              {summary ? (
                <div className="session-turn-stage-summary">
                  {renderTranscriptRow(summary, transcriptRowRenderOptions(renderProps, items, false, motionFocus, lastUserKey, 'inline', enteringItemIds, maintainLatestPosition, responseAnnotationsByItemId))}
                </div>
              ) : null}
              {rows.map((child) => {
                const content = renderTranscriptRow(
                  child,
                  transcriptRowRenderOptions(
                    renderProps,
                    items,
                    !row.replyVisible && showActiveStatus && activeTurnId === row.turnId,
                    motionFocus,
                    lastUserKey,
                    /** 整轮回看按段折叠操作；逐段进展已经由各段外层数量入口控制。 */
                    row.replyVisible ? 'detail' : 'inline',
                    enteringItemIds,
                    maintainLatestPosition,
                    responseAnnotationsByItemId,
                  ),
                );
                return active ? (
                  <div className="session-live-turn-row" key={child.key} data-navigation-row-key={child.key}>
                    {content}
                  </div>
                ) : (
                  <div key={child.key} data-navigation-row-key={child.key}>
                    {content}
                  </div>
                );
              })}
            </section>
          );
        });
      if (!turn) {
        const hasProcessDetails = row.segments.length > 0 || (row.loadMore && turnProcessAvailable(props.state.snapshot, row.turnId));
        return (
          <>
            {hasProcessDetails ? (
              <SessionTurnProcessDisclosure
                language={props.language}
                itemCount={row.replyVisible ? undefined : processActivityCount}
                loading={Boolean(row.loadMore && processPaging?.loading)}
                error={row.loadMore ? processPaging?.error : null}
                open={expandedRowKeys.has(expansionKey)}
                onOpenChange={(open, trigger) => setTranscriptRowExpanded(expansionKey, open, trigger)}
                onOpen={async () => {
                  if (!row.loadMore) return;
                  if (turnProcessNeedsLoad(processPaging)) await renderProps.onLoadTurnProcess?.(row.turnId, turnCompleted);
                  await renderProps.onLoadTurnArtifacts?.(row.turnId);
                }}
              >
                {earlierProcess ? pageSentinel : null}
                {renderProcessSegments(processLive)}
                {earlierProcess ? null : pageSentinel}
              </SessionTurnProcessDisclosure>
            ) : null}
          </>
        );
      }
      const v2PagingKey = turn.providerTurnId ?? turn.id;
      const hasProcessDetails = row.segments.length > 0 || (row.loadMore && turnProcessAvailable(props.state.snapshot, v2PagingKey));
      const process = renderProcessSegments(processLive);
      return (
        <>
          {hasProcessDetails ? (
            <SessionTurnProcessDisclosure
              language={props.language}
              turn={(turnActive && !row.replyVisible) || projectedTurnWorkKeyByTurn.get(row.turnId) !== row.key ? undefined : turn}
              replyVisible={row.replyVisible}
              requests={props.state.pendingRequests}
              itemCount={row.replyVisible ? undefined : processActivityCount}
              loading={Boolean(row.loadMore && processPaging?.loading)}
              error={row.loadMore ? processPaging?.error : null}
              open={expandedRowKeys.has(expansionKey)}
              onOpenChange={(open, trigger) => setTranscriptRowExpanded(expansionKey, open, trigger)}
              onOpen={async () => {
                if (!row.loadMore) return;
                if (turnProcessNeedsLoad(processPaging)) await renderProps.onLoadTurnProcess?.(row.turnId, turnCompleted);
                await renderProps.onLoadTurnArtifacts?.(row.turnId);
              }}
            >
              {earlierProcess ? pageSentinel : null}
              {process}
              {earlierProcess ? null : pageSentinel}
            </SessionTurnProcessDisclosure>
          ) : null}
          {!turnActive && containsCompletionAnchor ? renderTurnArtifacts(row.turnId, renderProps, completionAnchorKeyByTurn[row.turnId]) : null}
        </>
      );
    }
    const rowItems = row.kind === 'item' ? [row.item] : row.items;
    const lastRowItem = rowItems[rowItems.length - 1]!;
    const turn = props.state.turnsByProviderId[lastRowItem.turnId];
    const anchorsTurnArtifacts = completionAnchorKeyByTurn[lastRowItem.turnId] === lastRowItem.key;
    /** 正文之后还有交付资源时，耗时仍显示在正文之前。 */
    const anchorsTurnSummary = turnSummaryAnchorKeyByTurn[lastRowItem.turnId] === lastRowItem.key;
    /** 未加载过程或没有操作的轮次，也在非空正文出现时显示耗时。 */
    const replyVisible = isFinalAnswerItem(lastRowItem) && Boolean(transcriptItemText(lastRowItem).trim());
    const v2PagingKey = turn?.providerTurnId ?? turn?.id ?? lastRowItem.turnId;
    const expansionKey = turnProcessExpansionKey(v2PagingKey);
    const v2ProcessPaging = turnDetailPaging(props.state.snapshot, v2PagingKey);
    /** 没有详情的完成轮次首次从头读取，已有末页继续复用。 */
    const turnCompleted = props.state.terminalTurnIds[lastRowItem.turnId] === 'completed' || turn?.status === 'completed';
    const v2Turn = props.state.snapshot?.snapshotV2
      ? [...props.state.snapshot.snapshotV2.recentClosedTurns, ...(props.state.snapshot.snapshotV2.activeTurn ? [props.state.snapshot.snapshotV2.activeTurn] : [])].find(
          (candidate) => candidate.id === turn?.id || (turn?.providerTurnId && candidate.providerTurnId === turn.providerTurnId),
        )
      : undefined;
    // 入口只能来自可见过程事实。缺少 turn summary 或仅有历史视图会隐藏的 reasoning，
    // 都不能凭最终回答臆造一个展开后为空的“查看处理过程”。
    const historicalProcessAvailable = Boolean(v2Turn?.process.available);
    const showV2DeferredDetails = Boolean(anchorsTurnSummary && !projectedTurnWorkKeyByTurn.has(lastRowItem.turnId) && historicalProcessAvailable && (replyVisible || !turn || !isActiveSessionTurn(turn)));
    /** 只剩用户输入的结束轮次仍先显示输入，随后显示其耗时。 */
    const opensWithUserMessage = itemRole(lastRowItem) === 'user';
    /** 同一消息仅渲染一次，根据消息角色决定它与轮次摘要的先后关系。 */
    const content = renderTranscriptRow(row, transcriptRowRenderOptions(renderProps, items, showActiveStatus, motionFocus, lastUserKey, 'detail', enteringItemIds, maintainLatestPosition, responseAnnotationsByItemId));
    return (
      <>
        {opensWithUserMessage ? content : null}
        {showV2DeferredDetails ? (
          <SessionTurnProcessDisclosure
            language={props.language}
            turn={turn}
            replyVisible={replyVisible}
            requests={props.state.pendingRequests}
            labelKind={historicalProcessAvailable ? 'process' : 'details'}
            loading={Boolean(v2ProcessPaging?.loading)}
            error={v2ProcessPaging?.error}
            open={expandedRowKeys.has(expansionKey)}
            onOpenChange={(open, trigger) => setTranscriptRowExpanded(expansionKey, open, trigger)}
            onOpen={async () => {
              if (turnProcessNeedsLoad(v2ProcessPaging)) await renderProps.onLoadTurnProcess?.(lastRowItem.turnId, turnCompleted);
              await renderProps.onLoadTurnArtifacts?.(lastRowItem.turnId);
            }}
          >
            {null}
          </SessionTurnProcessDisclosure>
        ) : null}
        {/* 无过程的轮次在可见正文前显示耗时，不生成空的展开按钮。 */}
        {anchorsTurnSummary && turn && (replyVisible || !isActiveSessionTurn(turn)) && !projectedTurnWorkKeyByTurn.has(lastRowItem.turnId) && !showV2DeferredDetails ? (
          <div className="session-turn-process-control">
            <SessionTurnDuration turn={turn} requests={props.state.pendingRequests} language={props.language} replyVisible={replyVisible} />
          </div>
        ) : null}
        {opensWithUserMessage ? null : content}
        {anchorsTurnArtifacts ? renderTurnArtifacts(lastRowItem.turnId, renderProps, lastRowItem.key) : null}
      </>
    );
  };

  return (
    <ConversationImageResourcesContext.Provider value={imageResourceContext}>
      <output className="session-sr-only session-transcript-announcement" aria-live="polite" aria-atomic="true">
        {completedAnnouncement ? <span key={completedAnnouncement.key}>{completedAnnouncement.text}</span> : null}
      </output>
      {resourcePaging?.error ? (
        <div role="alert" className="session-resource-load-error">
          <span>{props.language === 'zh-CN' ? '链接与附件信息读取失败。' : 'Unable to load links and attachments.'}</span>
          <button
            type="button"
            disabled={resourcePaging.loading}
            onClick={() => {
              void Promise.resolve(renderProps.onLoadConversationResources?.()).catch(() => undefined);
            }}
          >
            {props.language === 'zh-CN' ? '重试' : 'Retry'}
          </button>
        </div>
      ) : null}
      <div ref={shellRef} className="session-transcript-shell" data-navigation-ready={(showNavigation && !navigation.error) || undefined}>
        <section
          ref={containerRef}
          className="session-transcript"
          role="log"
          tabIndex={-1}
          aria-live="off"
          aria-label={props.language === 'zh-CN' ? '对话记录' : 'Conversation transcript'}
          onWheel={(event) => {
            if (event.deltaY !== 0) beginUserScrollIntent();
            if (event.deltaY < 0) armHistoryPaging();
          }}
          onTouchStart={() => beginUserScrollIntent()}
          onPointerDown={(event) => {
            const container = event.currentTarget;
            const rect = container.getBoundingClientRect();
            const scrollbarEdgeWidth = Math.max(12, container.offsetWidth - container.clientWidth);
            const scrollbarPointer = event.pointerType === 'mouse' && event.clientX >= rect.right - scrollbarEdgeWidth;
            const interactiveTarget = event.target instanceof Element && event.target.closest('button, input, textarea, select, a, [contenteditable="true"]');
            if (event.pointerType === 'mouse' && !scrollbarPointer && !interactiveTarget) container.focus({ preventScroll: true });
            if (event.pointerType !== 'mouse' || scrollbarPointer) beginUserScrollIntent(true);
          }}
          onKeyDown={(event) => {
            if (!transcriptVerticalScrollKeys.has(event.key)) return;
            const target = event.target;
            if (target instanceof Element && target.closest('button, input, textarea, select, a, [contenteditable="true"]')) return;
            beginUserScrollIntent();
          }}
          onScroll={(event) => {
            const userDriven = userScrollIntentRef.current;
            const mode = userDriven ? scrollController.onUserScroll(metrics(event.currentTarget)) : scrollController.getState();
            setReturnToLatestVisible(mode.mode === 'static');
            if (userDriven && mode.mode === 'static') {
              armHistoryPaging();
              rememberStaticReadingAnchor(event.currentTarget);
            }
            if (userDriven && mode.mode !== 'static') {
              clearStaticReadingAnchor();
              maintainLatestPosition();
            }
            if (userDriven && !userScrollPointerActiveRef.current) scheduleUserScrollIntentEnd();
            viewportVirtualizer.synchronizeViewport(event.currentTarget);
            updateNavigationCurrent(event.currentTarget);
            scheduleLatestContentVisibility();
          }}
        >
          <V2HistoryPageSentinel
            key={props.state.conversationId}
            state={props.state}
            enabled={historyPagingArmed && !navigation.snapshot}
            onIntersectionChange={updateHistorySentinelIntersection}
            onLoadEarlier={renderProps.onLoadEarlierHistory ? loadEarlierHistoryWithAnchor : undefined}
          />
          {turnRows.length > 0 ? (
            <div
              ref={viewportVirtualizer.windowRef}
              className="session-transcript-window"
              data-rendered-row-count={viewportVirtualizer.projection.renderedRowCount}
              data-total-row-count={turnRows.length}
              data-measurement-cache-count={viewportVirtualizer.measurementCacheSize}
            >
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
                  ? '发送消息，开始对话。'
                  : 'Send a message to start a conversation.'}
            </p>
          ) : null}
          {showCreationStatus && props.creationStatus ? <SessionCreationNotice status={props.creationStatus} language={props.language} /> : null}
          {showStandaloneActiveStatus && activeStatusKind ? (
            activeStatusKind === 'executing' && activeReasoningItem ? (
              <SessionReasoningSummary item={activeReasoningItem} language={props.language} status={reasoningSummaryStatus(activeReasoningItem, props.state)} motionActive onVisibleContentChange={maintainLatestPosition} />
            ) : (
              <TranscriptActiveStatus language={props.language} kind={activeStatusKind} reconnectAttempt={props.state.providerReconnectAttempt || props.state.reconnectAttempt} reconnectAttempts={props.state.providerReconnectAttempts} />
            )
          ) : null}
          {interactionAuthorityMissing && props.state.activeTurnId ? <InteractionAuthorityMissingNotice language={props.language} turnId={props.state.activeTurnId} onInterrupt={props.onInterrupt} /> : null}
          <span ref={latestContentMarkerRef} className="session-latest-content-marker" aria-hidden="true" />
        </section>
        {showNavigation ? <ConversationNavigation key={props.state.conversationId} entries={navigationEntries} activeRowKey={activeNavigationKey} language={props.language} shellRef={shellRef} onNavigate={navigateToEntry} /> : null}
        {props.onLoadNavigation && (navigation.error || navigationReadError || (!navigation.snapshot && navigation.loading)) ? (
          <div className="session-navigation-status" role="status">
            <span>{navigationReadError?.message ?? navigation.error ?? (props.language === 'zh-CN' ? '正在读取完整历史目录…' : 'Loading all messages…')}</span>
            {navigation.error || navigationReadError ? (
              <button
                type="button"
                onClick={() => {
                  if (navigationReadError) navigateToEntry(navigationReadError.entry);
                  else navigation.retry();
                }}
              >
                {props.language === 'zh-CN' ? '重试' : 'Retry'}
              </button>
            ) : null}
          </div>
        ) : null}
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
            clearUserScrollIntent();
            clearStaticReadingAnchor();
            positionLatest(container);
            setReturnToLatestVisible(false);
            maintainLatestPosition();
          }}
        >
          {props.language === 'zh-CN' ? '返回最新消息' : 'Return to latest'}
        </button>
        <TranscriptHistoryLoading visible={Boolean(props.historyLoading)} initializing={Boolean(props.state?.transcriptInitializing)} language={props.language} />
      </div>
    </ConversationImageResourcesContext.Provider>
  );
}

/** 冷读取沿用原加载层，只区分位置准备与普通历史读取。 */
function TranscriptHistoryLoading(props: { visible: boolean; initializing: boolean; language: SessionUiLanguage }) {
  return (
    <section className="session-transcript-loading" data-visible={props.visible || undefined} role={props.visible ? 'status' : undefined} aria-hidden={!props.visible} aria-live={props.visible ? 'polite' : undefined}>
      <span className="session-loading-line" />
      <span className="session-loading-line" />
      <strong>{props.initializing ? (props.language === 'zh-CN' ? '正在准备会话历史' : 'Preparing conversation history') : props.language === 'zh-CN' ? '正在加载会话' : 'Loading conversation'}</strong>
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

/** 只在缺页边界进入会话视口时补读，过程内不增加分页或重试按钮。 */
function TurnProcessPageSentinel(props: { enabled: boolean; paging: NonNullable<ReturnType<typeof turnDetailPaging>>; turnId: string; onLoad: (turnId: string) => void | Promise<void> }) {
  /** 观察真实的缺页位置，收起或滚动其他容器不触发读取。 */
  const sentinelRef = useRef<HTMLSpanElement>(null);
  /** 同一游标最多请求一次，失败或没有推进时停止自动补页。 */
  const requestedCursorRef = useRef<string | null>(null);
  /** 可见性独立于已读数据，重新展开复用控制器保留的分页范围。 */
  const [intersecting, setIntersecting] = useState(false);
  useEffect(() => {
    /** 缺页标记随折叠内容挂载，观察器随内容卸载释放。 */
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    /** 沿用时间线的滚动容器与边界观察方式。 */
    const observer = new IntersectionObserver((entries) => setIntersecting(entries.some((entry) => entry.isIntersecting)), { root: sentinel.closest('.session-transcript') });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!props.enabled || !intersecting || !props.paging.hasMore || props.paging.loading || props.paging.error || requestedCursorRef.current === props.paging.cursor) return;
    requestedCursorRef.current = props.paging.cursor;
    void Promise.resolve(props.onLoad(props.turnId)).catch(() => undefined);
  }, [intersecting, props.enabled, props.onLoad, props.paging.cursor, props.paging.error, props.paging.hasMore, props.paging.loading, props.turnId]);
  return <span ref={sentinelRef} className="session-turn-process-page-sentinel" data-process-page aria-hidden="true" />;
}

/** 创建与重试共用执行状态的文字排版和扫光，失败继续保留原位恢复入口。 */
function SessionCreationNotice(props: { status: SessionCreationStatus; language: SessionUiLanguage }) {
  if (props.status.state !== 'creating' && props.status.state !== 'retrying') {
    return (
      <section className={`session-creation-status is-${props.status.state}`} role="alert" aria-live="assertive">
        <div className="session-creation-status-error">
          <VisibleApplicationError error={props.status.errorCause ?? props.status.error ?? props.status.message} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
        </div>
        {props.status.onRetry ? (
          <button type="button" onClick={() => void props.status.onRetry?.()}>
            {props.status.retryLabel ?? (props.language === 'zh-CN' ? '重试' : 'Retry')}
          </button>
        ) : null}
      </section>
    );
  }
  /** 重试计数沿用实际创建状态，普通连接文案由调用方提供。 */
  const retryingMessage = props.status.state === 'retrying' ? `${props.language === 'zh-CN' ? '正在重试' : 'Retrying'}… ${props.status.retryAttempt ?? 1}/${props.status.maxRetries ?? 5}` : props.status.message;
  return (
    <section className={`session-creation-status is-${props.status.state}`} role="status" aria-live="polite">
      {sessionConnectionSymbol}
      <SessionSweepText className="session-current-status-text" text={retryingMessage} active />
    </section>
  );
}

/** 沿用既有会话提示外观，具体状态的文案、操作和播报级别由调用方保留。 */
function ConversationNotice(props: { children: ReactNode; label: string; role?: 'alert' | 'status'; deliveryState?: 'unconfirmed' | 'failed' | 'provider-stop-pending' | 'interaction-recovery-pending' }) {
  return (
    <section
      className={`session-turn-failure${props.deliveryState ? ' session-message-delivery-feedback' : ''}`}
      data-state={props.deliveryState}
      role={props.role ?? 'alert'}
      aria-live={props.role === 'status' ? 'polite' : 'assertive'}
      aria-label={props.label}
    >
      {turnFailureSymbol}
      <div className="session-turn-failure-message">{props.children}</div>
    </section>
  );
}

/** 模型返回错误保留独立名称，避免与消息发送状态混淆。 */
function TurnFailureCard(props: { failure: NativeTurnFailureSnapshot; language: SessionUiLanguage; retainedAnswer: boolean }) {
  /** 错误名称和详情入口使用同一语言。 */
  const zh = props.language === 'zh-CN';
  /** 已保留回答的断流不能再误报为“没有收到完整回复”。 */
  const retainedStreamFailure = props.retainedAnswer && props.failure.cause?.code === 'responseStreamDisconnected';
  if (retainedStreamFailure) {
    return (
      <ConversationNotice role="status" label={zh ? '回答已保留' : 'Response retained'}>
        <span data-zeus-selectable="text">{zh ? '回答已保留，但 AI 服务未确认完整结束。你可以继续对话。' : 'The response was retained, but the AI service did not confirm a clean finish. You can continue the conversation.'}</span>
        <button type="button" className="application-error-details-link" onClick={() => reportApplicationError(props.failure, { language: zh ? 'zh-CN' : 'en', showDetails: true })}>
          {zh ? '错误详情' : 'Error details'}
        </button>
      </ConversationNotice>
    );
  }
  return (
    <ConversationNotice label={zh ? '模型返回错误' : 'Model error'}>
      <VisibleApplicationError error={props.failure} language={zh ? 'zh-CN' : 'en'} />
    </ConversationNotice>
  );
}

/** 判断失败轮次是否已经留下可读回答；只认非空最终回答，不把过程说明当作交付。 */
function turnHasRetainedAssistantAnswer(items: readonly NativeSessionItemBuffer[], turnId: string): boolean {
  return items.some((item) => item.turnId === turnId && isFinalAnswerItem(item) && item.text.trim().length > 0);
}

export type TranscriptRow =
  | {
      kind: 'item';
      key: string;
      item: NativeSessionItemBuffer;
      /** 结构化回答与 PLAN 已答题共用回显，作为处理过程行参与分组。 */
      questionAnswer?: AnsweredRequestHistoryProps['request'];
    }
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
  /** 最终正文已可见时切换过程展示，Provider 轮次仍可能继续流式输出。 */
  replyVisible?: boolean;
}

export interface TranscriptTurnProcessSegment {
  key: string;
  summary: TranscriptRow | null;
  rows: TranscriptRow[];
}

export type TranscriptTurnRow = TranscriptRow | TranscriptTurnWorkRow;

/** 目录补齐尚未读取的发言位置，不伪造一条可编辑或可发送的消息。 */
type TranscriptViewportRow =
  TranscriptTurnRow | { kind: 'navigation_placeholder'; key: string; entry: TranscriptNavigationEntry } | { kind: 'turn_failure'; key: string; turnId: string; occurredAt: string; failure: NativeTurnFailureSnapshot };

/** 失败属于发生时的会话记录，不依附最后一条消息或整个列表的底部。 */
export function projectTranscriptFailureRows(rows: readonly TranscriptViewportRow[], turns: NativeSessionState['turnsByProviderId']): TranscriptViewportRow[] {
  /** 本地与服务端身份可能指向同一轮，失败记录按持久轮次身份去重。 */
  const failures: Extract<TranscriptViewportRow, { kind: 'turn_failure' }>[] = [...new Map(Object.values(turns).map((turn) => [turn.id, turn])).values()]
    .filter((turn) => turn.status === 'failed' && turn.error)
    .map<Extract<TranscriptViewportRow, { kind: 'turn_failure' }>>((turn) => ({
      kind: 'turn_failure',
      key: `turn-failure:${turn.id}`,
      turnId: turn.providerTurnId ?? turn.id,
      occurredAt: turn.completedAt ?? turn.updatedAt ?? turn.createdAt,
      failure: turn.error!,
    }))
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  /** 顺序归并只插入失败记录，不重排既有消息、过程或历史占位。 */
  const result: TranscriptViewportRow[] = [];
  /** 每条失败只消费一次，长历史不会逐轮重复扫描。 */
  let cursor = 0;
  for (const row of rows) {
    /** 结束时间不会被后续流式刷新覆盖，普通记录使用首次进入时间线的时间。 */
    const occurredAt = transcriptViewportRowTime(row);
    while (cursor < failures.length) {
      /** 未被模型接手的后续消息仍属于队尾，即使排队提交早于本轮失败。 */
      const failure = failures[cursor]!;
      /** 同轮开场消息不能因缺少原生身份而被误判为下一次待发送消息。 */
      const pendingAfterFailure = row.kind === 'item' && isUnacceptedTranscriptMessage(row.item) && row.item.turnId !== failure.turnId;
      if (!pendingAfterFailure && (occurredAt < failure.occurredAt || (occurredAt === failure.occurredAt && transcriptTurnRowTurnId(row) === failure.turnId))) break;
      result.push(failure);
      cursor += 1;
    }
    result.push(row);
  }
  result.push(...failures.slice(cursor));
  return result;
}

/** 各类可见行共用稳定时间，折叠过程取首条记录，缺页占位取持久发言时间。 */
function transcriptViewportRowTime(row: TranscriptViewportRow): string {
  if (row.kind === 'turn_failure') return row.occurredAt;
  if (row.kind === 'navigation_placeholder') return row.entry.occurredAt;
  if (row.kind === 'turn_work') {
    /** 空过程没有可用于提前插入记录的时间。 */
    const first = row.segments.flatMap((segment) => [...(segment.summary ? [segment.summary] : []), ...segment.rows])[0];
    return first ? transcriptViewportRowTime(first) : '';
  }
  if (row.kind === 'answered_request') return row.request.resolvedAt ?? row.request.createdAt;
  return transcriptTimelineAt(row.kind === 'item' ? row.item : row.items[0]!);
}

/** 时间只用于失败提示和导航摘录，不参与正文条目排序。 */
function transcriptTimelineAt(item: NativeSessionItemBuffer): string {
  return item.timelineAt ?? item.updatedAt ?? '';
}

/** 真实正文行提供目录所需的身份、状态和短摘录。 */
function transcriptNavigationEntries(rows: readonly TranscriptTurnRow[], state: NativeSessionState): TranscriptNavigationEntry[] {
  /** 同轮补充发言共享最终答复，正式计划只作次选。 */
  const answers = new Map<string, { text: string; final: boolean }>();
  for (const row of rows) {
    if (row.kind !== 'item') continue;
    /** 使用会话已有的最终答复分类，不把思考和工具结果当回答。 */
    const final = isFinalAnswerItem(row.item);
    if (final || (row.item.type === 'plan' && !answers.get(row.item.turnId)?.final)) answers.set(row.item.turnId, { text: conversationNavigationExcerpt(transcriptItemText(row.item), 320), final });
  }
  return rows.flatMap((row): TranscriptNavigationEntry[] => {
    if (row.kind === 'turn_work')
      return transcriptNavigationEntries(
        row.segments.flatMap((segment) => [...(segment.summary ? [segment.summary] : []), ...segment.rows]),
        state,
      ).map((entry) => ({ ...entry, parentRowKey: row.key }));
    if (row.kind === 'answered_request') {
      /** 同步答题卡复用请求身份，整张卡只生成一条刻度。 */
      const excerpt = conversationQuestionNavigationExcerpt(row.request.payload, row.request.response, row.request.containsSecret);
      if (!excerpt || !row.request.turnId) return [];
      /** 正文使用模型轮次，历史加载使用本地轮次。 */
      const turn = state.turnsByProviderId[row.request.turnId];
      /** 与持久目录共享请求身份，不借用工具消息身份。 */
      const entry = {
        id: `request:${row.request.id}`,
        requestId: row.request.id,
        turnId: turn?.id ?? row.request.turnId,
        providerTurnId: turn?.providerTurnId ?? row.request.turnId,
        clientUserMessageId: null,
        providerItemId: null,
        sequence: 1,
        occurredAt: row.request.resolvedAt ?? row.request.createdAt,
        ...excerpt,
        status: row.request.status,
        loaded: true,
      };
      return [{ ...entry, rowKey: navigationRowKey(entry) }];
    }
    if (row.kind !== 'item' || itemRole(row.item) !== 'user') return [];
    /** 已显示的答题卡也属于已加载正文；等待回显不能再插入同身份的历史占位。 */
    const item = row.item;
    /** 无文字发言仍可按附件名称辨认。 */
    const attachments = Array.isArray(item.payload.attachments)
      ? item.payload.attachments
          .map((entry) => primitiveValue(recordValue(entry)?.name))
          .filter(Boolean)
          .join('、')
      : '';
    /** 已确认轮次优先使用模型身份，目录合并后保留本地读取身份。 */
    const turn = state.turnsByProviderId[item.turnId];
    /** 答题卡预览展示原问题和用户答案。 */
    const questionExcerpt = row.questionAnswer ? conversationQuestionNavigationExcerpt(row.questionAnswer.payload, row.questionAnswer.response, row.questionAnswer.containsSecret) : null;
    /** 持久行身份独立于模型编号；目录先于模型确认返回时仍能接管同一条正文。 */
    const entry = {
      id: item.localItemId ?? item.itemId,
      turnId: turn?.id ?? item.turnId,
      providerTurnId: turn?.providerTurnId ?? item.turnId,
      clientUserMessageId: item.clientUserMessageId ?? item.durableClientUserMessageId ?? null,
      providerItemId: item.providerItemId ?? null,
      sequence: typeof item.payload.v2Sequence === 'number' ? item.payload.v2Sequence : 0,
      occurredAt: transcriptTimelineAt(item),
      prompt: questionExcerpt?.prompt ?? conversationNavigationExcerpt(transcriptItemText(item) || attachments || item.resources.map((resource) => resource.displayName).join('、'), 160),
      response: questionExcerpt?.response ?? answers.get(item.turnId)?.text ?? '',
      status: state.terminalTurnIds[item.turnId] ?? turn?.status ?? item.status,
      loaded: true,
    };
    return [{ ...entry, rowKey: navigationRowKey(entry) }];
  });
}

/** 将缺失发言插回原有顺序，加载后的真实消息接管同一占位身份。 */
function projectNavigationRows(rows: readonly TranscriptTurnRow[], entries: readonly TranscriptNavigationEntry[]): TranscriptViewportRow[] {
  /** 模型、客户端和历史身份分别建索引，不按正文猜测关联。 */
  const byIdentity = new Map<string, TranscriptNavigationEntry>();
  for (const entry of entries) {
    byIdentity.set(`history:${entry.id}`, entry);
    if (entry.providerItemId) byIdentity.set(`provider:${entry.providerItemId}`, entry);
    if (entry.clientUserMessageId) byIdentity.set(`client:${entry.clientUserMessageId}`, entry);
  }
  /** 仅缺失正文的发言需要占位，重复标题的独立发送仍分别保留。 */
  const pending = entries.filter((entry) => !entry.loaded);
  /** 顺序合并保持原有处理过程与交付卡的相对次序。 */
  const result: TranscriptViewportRow[] = [];
  /** 顺序指针避免为每条历史重新扫描所有正文行。 */
  let cursor = 0;
  for (const row of rows) {
    /** 过程组以首条记录的时间确定其在用户发言之间的位置。 */
    const first = row.kind === 'turn_work' ? row.segments.flatMap((segment) => [...(segment.summary ? [segment.summary] : []), ...segment.rows])[0] : row;
    /** 稳定首次时间来自既有投影，不使用流式文本更新时间重排。 */
    const timestamp = transcriptViewportRowTime(row);
    /** 持久消息优先比较会话顺序，批量恢复的相同时间不能把后续占位提前。 */
    const sequence = first && first.kind !== 'answered_request' ? (first.kind === 'item' ? first.item : first.items[0])?.payload.v2Sequence : undefined;
    while (cursor < pending.length && (!pending[cursor]!.requestId && typeof sequence === 'number' && sequence > 0 ? pending[cursor]!.sequence < sequence : pending[cursor]!.occurredAt <= timestamp)) {
      /** 占位与未来真实行使用相同 key，保持阅读锚点。 */
      const entry = pending[cursor++]!;
      result.push({ kind: 'navigation_placeholder', key: entry.rowKey, entry });
    }
    if (row.kind === 'turn_work') {
      /** 仅投影已加载子行的身份，不在折叠过程内再插一份历史占位。 */
      const loadedEntries = entries.filter((entry) => entry.parentRowKey === row.key).map((entry) => ({ ...entry, loaded: true }));
      result.push({ ...row, segments: row.segments.map((segment) => ({ ...segment, rows: projectNavigationRows(segment.rows, loadedEntries) as TranscriptRow[] })) });
    } else if (row.kind === 'answered_request') {
      /** 卡片所在的真实行直接接管目录身份，点击不会停在占位上。 */
      const entry = byIdentity.get(`history:request:${row.request.id}`);
      result.push(entry ? { ...row, key: entry.rowKey } : row);
    } else if (row.kind === 'item' && itemRole(row.item) === 'user') {
      /** 客户端身份优先，历史页接管时不重建用户气泡所在的行。 */
      const entry =
        [row.item.clientUserMessageId, row.item.durableClientUserMessageId]
          .filter(Boolean)
          .map((id) => byIdentity.get(`client:${id}`))
          .find(Boolean) ??
        (row.item.providerItemId ? byIdentity.get(`provider:${row.item.providerItemId}`) : undefined) ??
        byIdentity.get(`history:${row.item.localItemId ?? row.item.itemId}`);
      result.push(entry ? { ...row, key: entry.rowKey } : row);
      // 用户消息已经接管占位时，仍为后续分页中的回复保留独立的可见补读入口。
      if (entry?.needsTurnContent) result.push({ kind: 'navigation_placeholder', key: `content:${entry.rowKey}`, entry });
    } else result.push(row);
  }
  for (; cursor < pending.length; cursor += 1) {
    /** 尾部尚未读取的发言仍占有真实位置。 */
    const entry = pending[cursor]!;
    result.push({ kind: 'navigation_placeholder', key: entry.rowKey, entry });
  }
  return result;
}

/** 只在占位真正靠近视口时读取对应轮次；失败保留在原位，等待用户重试。 */
function NavigationHistoryPlaceholder(props: { entry: TranscriptNavigationEntry; language: SessionUiLanguage; onLoad?: (turnId: string) => Promise<void> }) {
  /** 观察真实占位，虚拟列表远处保留的节点不能触发无关读取。 */
  const ref = useRef<HTMLElement | null>(null);
  /** 同一占位失败后不因重复相交自动重放。 */
  const [attempt, setAttempt] = useState(0);
  /** 状态只影响此处占位，不覆盖整个会话。 */
  const [status, setStatus] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  useEffect(() => {
    if (!ref.current || !props.onLoad) return;
    /** 卸载或切换目标后不处理旧结果。 */
    let cancelled = false;
    /** 一次相交只发起一次读取。 */
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setStatus({ loading: true, error: null });
        // 正文合并后由真实行接管；请求完成先于 React 提交，不能在这段间隙制造一次错误闪烁。
        void props.onLoad!(props.entry.turnId).catch((error: unknown) => {
          if (!cancelled) setStatus({ loading: false, error: error instanceof Error ? error.message : '正文读取失败。' });
        });
      },
      { root: ref.current.closest('.session-transcript'), rootMargin: '200px 0px' },
    );
    observer.observe(ref.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [props.entry.turnId, props.onLoad, props.language, attempt]);
  return (
    <section ref={ref} className="session-navigation-placeholder" aria-busy={status.loading}>
      {status.error ? <span role="alert">{status.error}</span> : null}
      {status.error ? (
        <button type="button" onClick={() => setAttempt((current) => current + 1)}>
          {props.language === 'zh-CN' ? '重试' : 'Retry'}
        </button>
      ) : null}
    </section>
  );
}

interface TranscriptRowRenderOptions {
  props: ConversationTranscriptProps;
  items: readonly NativeSessionItemBuffer[];
  showThinking: boolean;
  motionFocus: SessionMotionFocus;
  lastUserKey: string | undefined;
  activityPresentation: 'inline' | 'detail';
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
  activityPresentation: 'inline' | 'detail',
  enteringItemIds: ReadonlySet<string>,
  onVisibleContentChange: () => void,
  responseAnnotationsByItemId: ReadonlyMap<string, ConversationResponseAnnotation[]>,
): TranscriptRowRenderOptions {
  return { props, items, showThinking, motionFocus, lastUserKey, activityPresentation, enteringItemIds, onVisibleContentChange, responseAnnotationsByItemId };
}

/** 按消息种类复用展示组件；阶段摘要保持原顺序，操作列表与命令详情分别按需展开。 */
function renderTranscriptRow(row: TranscriptRow, options: TranscriptRowRenderOptions): ReactNode {
  if (row.kind === 'answered_request') return <AnsweredRequestHistory request={row.request} language={options.props.language} />;
  if (row.kind === 'activity') {
    return (
      <SessionActivityGroup
        items={row.items}
        category={row.category}
        collapsible={options.activityPresentation === 'detail'}
        language={options.props.language}
        enteringItemKeys={options.enteringItemIds}
        motionActive={row.motionActive || row.items.some(isLiveActivityItem) || row.items.some((item) => item.key === options.motionFocus?.itemKey)}
        onOpenResource={options.props.onOpenResource}
        onLoadResourcePreview={options.props.onLoadResourcePreview}
        onLoadToolResult={options.props.onLoadV2ToolResult}
        onLoadContent={options.props.onLoadV2Content}
      />
    );
  }
  // 已送达的异步回答直接使用 PLAN 已答题组件，不再套用户消息及其操作栏。
  if (row.questionAnswer && row.item.status === 'completed' && !row.item.optimistic) return <AnsweredRequestHistory request={row.questionAnswer} language={options.props.language} />;
  if (itemRole(row.item) === 'assistant' && classifyAssistantMessage(row.item.payload, row.item.phase) === 'question') {
    return <AsyncQuestionMessage item={row.item} state={options.props.state} language={options.props.language} onOpen={row.item.status === 'completed' ? options.props.onOpenAsyncQuestion : undefined} />;
  }
  if (row.item.type === 'plan') {
    return (
      <TranscriptV2ContentBoundary item={row.item} onLoadContent={options.props.onLoadV2Content}>
        <PlanSummary item={row.item} language={options.props.language} motionActive={row.item.key === options.motionFocus?.itemKey} panelOpen={isSamePlanItem(options.props.openPlanItem, row.item)} onOpenPanel={options.props.onOpenPlan} />
      </TranscriptV2ContentBoundary>
    );
  }
  // 持久思考正文沿用下面的共享过程消息；只有短暂运行摘要使用专门的状态行。
  if (normalizeItemType(row.item.type) === 'reasoning' && !isReasoningProcessText(row.item)) {
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
  return (
    <TranscriptV2ContentBoundary item={row.item} onLoadContent={options.props.onLoadV2Content}>
      <ThreadItemView
        item={row.item}
        questionAnswer={row.questionAnswer}
        language={options.props.language}
        assistantLabel={options.props.assistantLabel}
        isLatest={options.activityPresentation === 'detail' && row.item.key === options.items[options.items.length - 1]?.key && !options.showThinking}
        animateEntrance={options.enteringItemIds.has(row.item.key)}
        showAssistantActions={options.activityPresentation === 'detail' && isFinalAnswerItem(row.item) && !options.showThinking}
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
        onRetryExpertExecution={options.props.onRetryQueuedSubmission}
      />
      {showPendingDeliveryFeedback ? (
        <MessageDeliveryOutcomeFeedback
          item={row.item}
          submissionId={queuedSubmission?.id}
          language={options.props.language}
          onOpenAiSettings={options.props.onOpenAiSettings}
          onRecoverQueue={options.props.onRecoverQueue}
          onReconnectCodex={options.props.onReconnectCodex}
          onRetryQueuedSubmission={options.props.onRetryQueuedSubmission}
          onCancelQueuedSubmission={options.props.onCancelQueuedSubmission}
          clientUserMessageId={row.item.clientUserMessageId ?? row.item.durableClientUserMessageId}
          onRetryPendingSend={options.props.onRetryPendingSend}
          onCancelPendingSend={options.props.onCancelPendingSend}
        />
      ) : null}
    </TranscriptV2ContentBoundary>
  );
}

function TranscriptV2ContentBoundary(props: { item: NativeSessionItemBuffer; onLoadContent?: (handle: string) => Promise<void>; children: ReactNode }): ReactNode {
  const handle = typeof props.item.payload.v2ContentHandle === 'string' && props.item.payload.v2ContentHandle ? props.item.payload.v2ContentHandle : null;
  // 轮次过程展开后，思考正文和普通阶段说明共用全文加载，不再要求第二次展开。
  const truncated = (props.item.payload.v2ContentKind === 'model_history' || isReasoningProcessText(props.item)) && props.item.payload.v2ContentTruncated === true;
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

function isSamePlanItem(openItem: NativeSessionItemBuffer | null | undefined, item: NativeSessionItemBuffer): boolean {
  if (!openItem) return false;
  if (openItem.key === item.key) return true;
  if (openItem.providerItemId && item.providerItemId && openItem.providerItemId === item.providerItemId) return true;
  if (openItem.localItemId && item.localItemId && openItem.localItemId === item.localItemId) return true;
  return openItem.itemId === item.itemId && openItem.turnId === item.turnId;
}

/** 运行状态只读取正式轮次、请求、连接及过程事件，不从计时或正文猜测。 */
export function transcriptRunStatus(state: NativeSessionState): 'starting' | 'executing' | 'compacting' | 'waiting_input' | 'waiting_approval' | 'reconnecting' | null {
  if (state.providerReconnectAttempt > 0) return 'reconnecting';
  if (state.conversationState === 'starting_turn') return 'starting';
  if (!state.activeTurnId || state.terminalTurnIds[state.activeTurnId]) return null;
  if (state.transportState !== 'ready') return 'reconnecting';
  if (state.conversationState === 'waiting_user_input') return 'waiting_input';
  if (state.conversationState === 'waiting_approval') return 'waiting_approval';
  if (state.conversationState !== 'active_prework' && state.conversationState !== 'active_final_answer') return null;
  if (Object.values(state.items).some((item) => item.turnId === state.activeTurnId && normalizeItemType(item.type) === 'contextcompaction' && item.status === 'in_progress')) return 'compacting';
  return 'executing';
}

/** 任务耗时仍单独显示；此处不把时间增长当作模型继续推进的证据。 */
function TranscriptActiveStatus(props: { language: SessionUiLanguage; kind: NonNullable<ReturnType<typeof transcriptRunStatus>>; reconnectAttempt: number; reconnectAttempts: number }): ReactNode {
  // 整理状态与活动记录沿用同一套用户表述，由当前状态位置统一承载进度。
  const labels = {
    starting: ['正在启动处理', 'Starting processing'],
    executing: ['正在执行', 'Executing'],
    compacting: ['正在整理较早对话以继续工作', 'Organizing earlier conversation to continue'],
    waiting_input: ['等待回答，请处理问题表单', 'Waiting for your answer'],
    waiting_approval: ['等待审批，请处理审批事项', 'Waiting for your approval'],
    reconnecting: ['正在恢复连接，运行进度尚未确认', 'Reconnecting; progress is not yet confirmed'],
  };
  /** Provider 五次核对显示明确计数；普通 Renderer 重连没有固定总数，保留原文案。 */
  const retryLabel =
    props.kind === 'reconnecting' && props.reconnectAttempt > 0 && props.reconnectAttempts > 0
      ? props.language === 'zh-CN'
        ? `正在恢复连接（${props.reconnectAttempt}/${props.reconnectAttempts}）`
        : `Reconnecting (${props.reconnectAttempt}/${props.reconnectAttempts})`
      : labels[props.kind][props.language === 'zh-CN' ? 0 : 1];
  return (
    <p className="session-transcript-thinking" role="status" aria-live="polite">
      <SessionSweepText className="session-current-status-text" text={retryLabel} active />
    </p>
  );
}

/** 问题暂不可用时保留停止入口，外观与其他会话提示一致。 */
function InteractionAuthorityMissingNotice(props: { language: SessionUiLanguage; turnId: string; onInterrupt?: (turnId: string) => void | Promise<void> }): ReactNode {
  /** 等待停止完成期间禁用重复操作。 */
  const [stopping, setStopping] = useState(false);
  /** 沿用当前轮次的停止操作，不改变回答或队列状态。 */
  const stop = () => {
    if (!props.onInterrupt || stopping) return;
    setStopping(true);
    void Promise.resolve(props.onInterrupt(props.turnId)).finally(() => setStopping(false));
  };
  return (
    <ConversationNotice deliveryState="unconfirmed" label={props.language === 'zh-CN' ? '问题暂不可用' : 'Question unavailable'}>
      <span>{props.language === 'zh-CN' ? 'AI 正在等待你的回答，但 Zeus 暂时无法显示可回答的问题。' : 'The AI is waiting for your answer, but Zeus cannot currently display a question you can respond to.'}</span>
      <div className="session-message-delivery-actions">
        <button type="button" disabled={!props.onInterrupt || stopping} onClick={stop}>
          {stopping ? (props.language === 'zh-CN' ? '正在停止…' : 'Stopping…') : props.language === 'zh-CN' ? '停止当前任务' : 'Stop current turn'}
        </button>
      </div>
    </ConversationNotice>
  );
}

/** 发送失败在原消息旁重试；送达未知时只核对状态，避免重复发送。 */
export function MessageDeliveryOutcomeFeedback(props: {
  item: NativeSessionItemBuffer;
  submissionId?: string;
  language: SessionUiLanguage;
  /** 打开现有登录或模型设置页，不代替用户修改配置。 */
  onOpenAiSettings?: (section: 'runtime' | 'models') => void;
  onRecoverQueue?: () => void | Promise<void>;
  onReconnectCodex?: () => void | Promise<void>;
  onRetryQueuedSubmission?: (submissionId: string) => void | Promise<void>;
  onCancelQueuedSubmission?: (submissionId: string) => void | Promise<void>;
  clientUserMessageId?: string;
  onRetryPendingSend?: (clientUserMessageId: string, intent: 'check' | 'continue') => void | Promise<void>;
  onCancelPendingSend?: (clientUserMessageId: string) => void | Promise<void>;
}): ReactNode {
  /** 操作期间禁用按钮，失败原因仍留在原消息旁。 */
  const [pending, setPending] = useState(false);
  /** 保留本次重试或核对的错误，不覆盖原消息的持久送达记录。 */
  const [actionError, setActionError] = useState<unknown>(null);
  const pausedReason = props.item.payload.pausedReason;
  const interactionResponseRecovery = props.item.payload.recoveryKind === 'interaction_response';
  if (interactionResponseRecovery && props.item.status === 'queued') {
    return (
      <ConversationNotice deliveryState="interaction-recovery-pending" role="status" label={props.language === 'zh-CN' ? '正在恢复对话' : 'Restoring conversation'}>
        {props.language === 'zh-CN' ? '正在恢复对话并继续处理你的回答…' : 'Restoring the conversation to continue with your answer…'}
      </ConversationNotice>
    );
  }
  if (pausedReason === 'provider_stop_pending') {
    return (
      <ConversationNotice deliveryState="provider-stop-pending" role="status" label={props.language === 'zh-CN' ? '正在确认运行状态' : 'Checking run status'}>
        {props.language === 'zh-CN' ? '正在确认上次运行已停止，确认后将自动继续' : 'Confirming the previous run has stopped. This message will continue automatically afterward.'}
      </ConversationNotice>
    );
  }
  const deliveryError = nativeSessionErrorFrom(props.item.payload.deliveryError) ?? nativeSessionErrorFrom(props.item.payload.error);
  const unconfirmed = props.item.status === 'unconfirmed' || props.item.status === 'paused';
  const failed = props.item.status === 'failed';
  if (!failed && !unconfirmed) return null;
  const feedbackState = failed ? 'failed' : 'unconfirmed';
  /** 确切的未知送达仅开放核对；普通重试也会由现有接口先检查未发送证据。 */
  const checkOnly = Boolean(props.submissionId) && (props.item.status === 'unconfirmed' || pausedReason === 'outcome_unknown');
  /** 已落库消息沿用提交身份，本地发送失败沿用原客户端消息身份。 */
  const canAct = props.submissionId ? Boolean(checkOnly ? props.onRecoverQueue : props.onRetryQueuedSubmission) : Boolean(props.clientUserMessageId && props.onRetryPendingSend);
  /** 复用现有重试与只读核对，不把失败正文重新作为一条普通新消息提交。 */
  async function retryDelivery(): Promise<void> {
    if (pending || !canAct) return;
    setPending(true);
    setActionError(null);
    try {
      if (props.submissionId) {
        if (checkOnly) await props.onRecoverQueue?.();
        else await props.onRetryQueuedSubmission?.(props.submissionId);
      } else if (props.clientUserMessageId) {
        await props.onRetryPendingSend?.(props.clientUserMessageId, checkOnly ? 'check' : 'continue');
      }
    } catch (error) {
      setActionError(error);
    } finally {
      setPending(false);
    }
  }

  return (
    <ConversationNotice deliveryState={feedbackState} label={props.language === 'zh-CN' ? '消息发送状态' : 'Message delivery status'}>
      {actionError || deliveryError ? (
        <VisibleApplicationError className="session-message-delivery-error" error={actionError ?? deliveryError} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
      ) : (
        <span>
          {unconfirmed && pausedReason !== 'recovered_unsent'
            ? props.language === 'zh-CN'
              ? '暂时无法确认消息的发送状态。'
              : 'Message delivery status is not yet confirmed.'
            : props.language === 'zh-CN'
              ? '消息尚未发送。'
              : 'This message has not been sent.'}
        </span>
      )}
      {canAct ? (
        <div className="session-message-delivery-actions">
          <button type="button" disabled={pending} onClick={() => void retryDelivery()}>
            {pending ? (props.language === 'zh-CN' ? '处理中…' : 'Working…') : checkOnly ? (props.language === 'zh-CN' ? '检查处理状态' : 'Check processing status') : props.language === 'zh-CN' ? '重试' : 'Retry'}
          </button>
        </div>
      ) : null}
    </ConversationNotice>
  );
}

function shouldShowPendingMessageDeliveryFeedback(item: NativeSessionItemBuffer, showActiveStatus: boolean): boolean {
  if (item.payload.recoveryKind === 'interaction_response' && item.status === 'queued') return true;
  if (item.status === 'failed' || item.status === 'unconfirmed') return true;
  if (item.status === 'queued') return false;
  if (item.status === 'paused')
    return (
      Boolean(item.payload.deliveryError || item.payload.error) ||
      item.payload.pausedReason === 'outcome_unknown' ||
      item.payload.pausedReason === 'recovery_required' ||
      item.payload.pausedReason === 'provider_stop_pending' ||
      item.payload.pausedReason === 'recovered_unsent'
    );
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
    ...(error.cause ? { cause: userFacingErrorCause(error.cause) } : {}),
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
  // 全部路径被拒绝时没有可列出的文件，仍在本轮保留局部原因与详情入口。
  return (
    <>
      {changeSet && changeSet.state !== 'capturing' && (changeSet.fileCount > 0 || changeSet.state === 'conflicted' || changeSet.conflict) ? (
        <TurnChangeCard changeSet={changeSet} language={props.language} onReview={props.onReviewTurnChanges} onOperate={props.onOperateTurnChangeSet} />
      ) : null}
    </>
  );
}

/** 运行中按沟通边界展示进展；非空最终正文出现时把过程收在它上方。 */
export function projectTranscriptTurnRows(
  rows: readonly TranscriptRow[],
  activeTurnId: string | null = null,
  terminalTurnIds: Readonly<Record<string, 'completed' | 'interrupted' | 'failed'>> = {},
  processAvailableTurnIds: ReadonlySet<string> = new Set(),
): TranscriptTurnRow[] {
  const orderedRows = projectDeliverablesAfterFinalAnswer(rows);
  const completionOutputTurnIds = new Set(orderedRows.flatMap((row) => (row.kind === 'item' && isTurnCompletionOutputItem(row.item) ? [row.item.turnId] : [])));
  /** 活动轮次和已结束轮次共用消息边界，展开与收起都不能改变沟通顺序。 */
  const projectedTurnIds = new Set([...completionOutputTurnIds, ...Object.keys(terminalTurnIds), ...(activeTurnId ? [activeTurnId] : [])]);
  const projected: TranscriptTurnRow[] = [];
  /** 已加载过程用于判断是否还需生成一个空的按需加载入口。 */
  const loadedProcessTurnIds = new Set<string>();
  /** Provider 事件早于开场消息落库时，持久输入身份仍负责把过程放回用户消息之后。 */
  const userAnchorByOpeningInputId = new Map<string, { index: number; rowKey: string; turnId: string }>();
  /** 缺少持久输入身份的旧记录只兼容同轮第一条普通用户消息。 */
  const firstUserAnchorByTurn = new Map<string, { index: number; rowKey: string; turnId: string }>();
  orderedRows.forEach((row, index) => {
    if (row.kind !== 'item' || row.questionAnswer || itemRole(row.item) !== 'user') return;
    firstUserAnchorByTurn.set(row.item.turnId, firstUserAnchorByTurn.get(row.item.turnId) ?? { index, rowKey: row.key, turnId: row.item.turnId });
    const openingInputId = itemOpeningInputId(row.item);
    if (openingInputId) userAnchorByOpeningInputId.set(openingInputId, { index, rowKey: row.key, turnId: row.item.turnId });
  });
  /** 延迟项只改变乱序到达的摆放位置，不改写其持久顺序或身份。 */
  const deferredWorkByUserRowKey = new Map<string, TranscriptTurnWorkRow[]>();
  for (let index = 0; index < orderedRows.length; index += 1) {
    const row = orderedRows[index]!;
    /** 没有轮次身份或不属于可归组轮次的内容保持原位。 */
    const turnId = transcriptRowTurnId(row);
    if (!turnId || !projectedTurnIds.has(turnId) || !isTurnProcessRow(row)) {
      projected.push(row);
      /** 前置过程等到对应用户消息出现后立即恢复，不跨越后续助手沟通。 */
      const deferred = deferredWorkByUserRowKey.get(row.key);
      if (deferred) projected.push(...deferred);
      continue;
    }
    /** 记录本组在持久时间线中的起点，用于判断是否真的早于用户消息到达。 */
    const chunkStartIndex = index;
    /** 即使输入正文尚未补齐，持久输入归属也必须切断不同输入的过程。 */
    const openingInputId = transcriptRowOpeningInputId(row);
    /** 只收拢相邻的过程行；任意用户输入、助手沟通、交互或交付物都会结束本组。 */
    const chunk = [row];
    while (index + 1 < orderedRows.length) {
      const candidate = orderedRows[index + 1]!;
      if (transcriptRowTurnId(candidate) !== turnId || transcriptRowOpeningInputId(candidate) !== openingInputId || !isTurnProcessRow(candidate)) break;
      chunk.push(candidate);
      index += 1;
    }
    /** Pi 工具条目可能携带本地轮次编号；同一开场输入统一沿用用户消息的 Provider 轮次身份。 */
    const userAnchor = openingInputId ? userAnchorByOpeningInputId.get(openingInputId) : firstUserAnchorByTurn.get(turnId);
    const projectedTurnId = userAnchor?.turnId ?? turnId;
    loadedProcessTurnIds.add(turnId);
    loadedProcessTurnIds.add(projectedTurnId);
    const boundaryIdentity = openingInputId ?? turnId;
    /** 沟通边界以消息身份区分，补入更早过程不能给后续组重新编号。 */
    const boundaryRow = orderedRows[chunkStartIndex - 1];
    /** 首组沿用开场身份；后续组绑定真正切断过程的消息。 */
    const boundaryKey = boundaryRow && boundaryRow.key !== userAnchor?.rowKey ? boundaryRow.key : null;
    /** 相同持久历史在冷读和补页后生成同一个过程身份。 */
    const key = `turn-work:${encodeURIComponent(boundaryIdentity)}${boundaryKey ? `:after:${encodeURIComponent(boundaryKey)}` : ''}`;
    const workRow: TranscriptTurnWorkRow = {
      kind: 'turn_work',
      key,
      turnId: projectedTurnId,
      // 行投影已经确定顺序与相邻操作组，此处只包裹显示，不按阶段再次收集或合并。
      segments: [{ key: `${key}:content`, summary: null, rows: chunk }],
      live: false,
      // 每段都可补齐同轮历史；新页沿持久位置加入原有顺序。
      loadMore: true,
    };
    /** 只有明确晚到的用户消息才接管位置；正常顺序的过程原位输出。 */
    if (userAnchor && userAnchor.index > chunkStartIndex) {
      const deferred = deferredWorkByUserRowKey.get(userAnchor.rowKey) ?? [];
      deferred.push(workRow);
      deferredWorkByUserRowKey.set(userAnchor.rowKey, deferred);
    } else {
      projected.push(workRow);
    }
  }

  /** 尚未加载过程正文时保留一个入口，避免 Snapshot 明确有过程却无处展开。 */
  for (const turnId of processAvailableTurnIds) {
    if (!projectedTurnIds.has(turnId) || loadedProcessTurnIds.has(turnId)) continue;
    /** 空入口跟随该轮最后一条普通用户输入，兼容过程尚未分页回来的历史会话。 */
    let anchorIndex = -1;
    let boundaryIdentity = turnId;
    for (let index = 0; index < projected.length; index += 1) {
      const candidate = projected[index]!;
      if (candidate.kind !== 'item' || candidate.item.turnId !== turnId || candidate.questionAnswer || itemRole(candidate.item) !== 'user') continue;
      anchorIndex = index;
      boundaryIdentity = itemOpeningInputId(candidate.item) ?? turnId;
    }
    /** 没有开场消息的旧记录放在该轮最后一条可见内容之后。 */
    if (anchorIndex < 0) for (let index = 0; index < projected.length; index += 1) if (transcriptTurnRowTurnId(projected[index]!) === turnId) anchorIndex = index;
    const placeholder: TranscriptTurnWorkRow = {
      kind: 'turn_work',
      key: `turn-work:${encodeURIComponent(boundaryIdentity)}`,
      turnId,
      segments: [],
      live: false,
      loadMore: true,
    };
    projected.splice(anchorIndex < 0 ? projected.length : anchorIndex + 1, 0, placeholder);
  }

  /** 最终正文可见即收拢过程；计划仍需轮次完成，空正文不提前切换。 */
  const completedReplyKeys = new Map<string, string>();
  for (const row of projected) {
    if (row.kind !== 'item' || !isTurnCompletionOutputItem(row.item) || !transcriptItemText(row.item).trim() || (terminalTurnIds[row.item.turnId] !== 'completed' && !isFinalAnswerItem(row.item))) continue;
    if (!completedReplyKeys.has(row.item.turnId)) completedReplyKeys.set(row.item.turnId, row.key);
  }
  /** 使用现有过程子行，保留操作和中途说明的先后顺序，不再按阶段重新排列。 */
  const completedProcessRows = new Map<string, TranscriptRow[]>();
  /** 被收拢的行只移入过程一次，用户输入、问题、错误和交付物继续独立显示。 */
  const completedProcessKeys = new Set<string>();
  for (const row of projected) {
    /** 操作组已经归一到开场用户消息所属轮次。 */
    const turnId = transcriptTurnRowTurnId(row);
    if (!turnId || !completedReplyKeys.has(turnId) || (row.kind !== 'turn_work' && !isTurnProcessRow(row, true))) continue;
    /** 空的历史过程入口也保留，展开后仍能按需补齐。 */
    const processRows = completedProcessRows.get(turnId) ?? [];
    if (row.kind === 'turn_work') {
      for (const segment of row.segments) processRows.push(...(segment.summary ? [segment.summary, ...segment.rows] : segment.rows));
    } else processRows.push(row);
    completedProcessRows.set(turnId, processRows);
    completedProcessKeys.add(row.key);
  }
  /** 正文出现时换成独立的折叠身份，后续流式输出与轮次结束不重置用户选择。 */
  const displayRows = projected.flatMap((row): TranscriptTurnRow[] => {
    if (completedProcessKeys.has(row.key)) return [];
    /** 模型正文原有身份不变，过程入口只放在它前面。 */
    const turnId = transcriptTurnRowTurnId(row);
    /** 未加载的过程允许为空，但无过程的轮次不新增空入口。 */
    const processRows = turnId ? completedProcessRows.get(turnId) : undefined;
    if (!turnId || completedReplyKeys.get(turnId) !== row.key || !processRows) return [row];
    /** 同一轮次在正文出现及结束后沿用稳定入口，单条命令详情默认收起。 */
    const key = `turn-work:${encodeURIComponent(turnId)}:completed`;
    return [{ kind: 'turn_work', key, turnId, segments: processRows.length ? [{ key: `${key}:content`, summary: null, rows: processRows }] : [], live: false, loadMore: true, replyVisible: true }, row];
  });

  /** 当前状态只有一处：活动轮次最后一个过程组负责显示当前或最近动作。 */
  let liveProcessIndex = -1;
  if (activeTurnId && !terminalTurnIds[activeTurnId] && !completedReplyKeys.has(activeTurnId)) {
    for (let index = 0; index < displayRows.length; index += 1) {
      const candidate = displayRows[index]!;
      if (candidate.kind === 'turn_work' && candidate.turnId === activeTurnId) liveProcessIndex = index;
    }
  }
  return displayRows.map((row, index) => (row.kind === 'turn_work' && row.live !== (index === liveProcessIndex) ? { ...row, live: index === liveProcessIndex } : row));
}

/** 操作数按原生条目计数，不用命令文本去重。 */
function turnProcessActivityCount(segments: readonly TranscriptTurnProcessSegment[]): number {
  return segments.reduce((count, segment) => count + segment.rows.reduce((segmentCount, row) => segmentCount + (row.kind === 'activity' ? row.items.length : 0), 0), 0);
}

/** 读取一行过程内容所属的持久普通输入。 */
function transcriptRowOpeningInputId(row: TranscriptRow): string | null {
  if (row.kind === 'answered_request') return null;
  const items = row.kind === 'item' ? [row.item] : row.items;
  return items.map(itemOpeningInputId).find((openingInputId): openingInputId is string => Boolean(openingInputId)) ?? null;
}

/** 正文图片接管同源交付，其余产物统一放在该轮最终正文之后。 */
function projectDeliverablesAfterFinalAnswer(rows: readonly TranscriptRow[]): readonly TranscriptRow[] {
  /** 只在同一轮次中接管图片，用户再次引用图片仍保留正文原位。 */
  const finalAnswerKeyByTurn = new Map<string, string>();
  /** 只有已登记且能实际渲染的正文图片才接管工具交付。 */
  const inlineImageRefsByTurn = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.kind !== 'item' || !isFinalAnswerItem(row.item)) continue;
    finalAnswerKeyByTurn.set(row.item.turnId, row.key);
    if (row.item.status !== 'completed') continue;
    /** 同轮多个正文段落共用资源身份，不合并正文内容。 */
    const refs = inlineImageRefsByTurn.get(row.item.turnId) ?? new Set<string>();
    /** 与 Markdown 图片节点使用同一套受信资源匹配规则。 */
    for (const match of transcriptItemText(row.item).matchAll(/!\[([^\]]*)\]\(([^)]+)\)/gu)) {
      /** 标签与地址共同选择当前真正显示的图片。 */
      const resource = matchingInlineResource(row.item.resources, match[1]!.trim(), match[2]!);
      if (resource?.kind === 'attachment' && isImageResource(resource) && /^assistant_image_[a-f0-9]{64}$/u.test(resource.attachmentRef)) refs.add(resource.attachmentRef);
    }
    inlineImageRefsByTurn.set(row.item.turnId, refs);
  }

  /** 同一图片的多个工具身份只保留一个独立交付。 */
  const deliveredImageRefsByTurn = new Map<string, Set<string>>();
  /** 仅调整展示资源，持久条目和工具过程保留原始身份。 */
  const distinctRows = rows.flatMap((row): TranscriptRow[] => {
    if (row.kind !== 'item' || row.item.status !== 'completed' || isFinalAnswerItem(row.item) || !isAssistantDeliverableItem(row.item)) return [row];
    /** 已展示的同轮图片身份不影响其他轮次。 */
    const deliveredRefs = deliveredImageRefsByTurn.get(row.item.turnId) ?? new Set<string>();
    /** 只有重复交付需要替换展示对象。 */
    let changed = false;
    /** 混合交付逐张核对，未被正文引用的图片继续展示。 */
    const resources = row.item.resources.map((resource) => {
      if (resource.delivery !== 'assistant' || resource.kind !== 'attachment' || !isImageResource(resource) || !/^assistant_image_[a-f0-9]{64}$/u.test(resource.attachmentRef)) return resource;
      if (!inlineImageRefsByTurn.get(row.item.turnId)?.has(resource.attachmentRef) && !deliveredRefs.has(resource.attachmentRef)) {
        deliveredRefs.add(resource.attachmentRef);
        return resource;
      }
      changed = true;
      /** 已被正文接管的工具图片仍可在处理过程中查看。 */
      return { ...resource, delivery: undefined };
    });
    deliveredImageRefsByTurn.set(row.item.turnId, deliveredRefs);
    if (!changed) return [row];
    if (typeof row.item.payload.v2SyntheticAssistantDeliverableItemId === 'string' && !resources.some((resource) => resource.delivery === 'assistant')) return [];
    return [{ ...row, item: { ...row.item, resources } }];
  });
  if (finalAnswerKeyByTurn.size === 0) return distinctRows;

  /** 未被正文接管的交付仍沿用最终回答后的摆放规则。 */
  const deliverablesByTurn = new Map<string, TranscriptRow[]>();
  for (const row of distinctRows) {
    if (row.kind !== 'item' || isFinalAnswerItem(row.item) || !isAssistantDeliverableItem(row.item) || !finalAnswerKeyByTurn.has(row.item.turnId)) continue;
    const deliverables = deliverablesByTurn.get(row.item.turnId) ?? [];
    deliverables.push(row);
    deliverablesByTurn.set(row.item.turnId, deliverables);
  }
  if (deliverablesByTurn.size === 0) return distinctRows;

  /** 保留原有正文顺序和资源交付位置。 */
  const projected: TranscriptRow[] = [];
  for (const row of distinctRows) {
    const turnId = transcriptRowTurnId(row);
    if (turnId && deliverablesByTurn.get(turnId)?.some((deliverable) => deliverable.key === row.key)) continue;
    projected.push(row);
    if (!turnId || finalAnswerKeyByTurn.get(turnId) !== row.key) continue;
    projected.push(...(deliverablesByTurn.get(turnId) ?? []));
  }
  return projected;
}

/** 只有完成态才收拢中途助手说明，最终正文与需要用户处理的消息保持外置。 */
function isTurnProcessRow(row: TranscriptRow, collapseAssistantMessages = false): boolean {
  // 已回答询问属于用户沟通正文，运行中和完成后都保持直接可见。
  if (row.kind === 'answered_request') return false;
  if (row.kind === 'activity') return true;
  // 思考过程中提交的结构化答复同样是用户消息，不能被完成态重新收进处理过程。
  if (row.questionAnswer) return false;
  // 缺少实时回答权限的恢复问题必须直接出现在时间线，不能折叠进普通工具过程。
  if (isRecoveredRequestUserInputItem(row.item) || (itemRole(row.item) === 'assistant' && classifyAssistantMessage(row.item.payload, row.item.phase) === 'question')) return false;
  // 计划和明确交付资源属于最终产物，必须独立展示，不能折叠进“已处理”过程。
  if (row.item.type === 'plan' || isAssistantDeliverableItem(row.item)) return false;
  // 思考内容保留独立的次要层级，不能冒充面向用户的进展说明。
  if (normalizeItemType(row.item.type) === 'reasoning') return true;
  // 运行中助手消息从创建起固定在主会话，完成后才将非最终说明收进过程。
  if (itemRole(row.item) === 'assistant' || itemRole(row.item) === 'commentary') return collapseAssistantMessages && !isFinalAnswerItem(row.item);
  // 明确失败需要直接可见，不能因为没有最终答复而藏进过程入口。
  if (itemRole(row.item) === 'error') return false;
  return itemRole(row.item) !== 'user' && !isFinalAnswerItem(row.item);
}

function transcriptRowTurnId(row: TranscriptRow): string | null {
  if (row.kind === 'answered_request') return row.request.turnId;
  return row.kind === 'item' ? row.item.turnId : (row.items[0]?.turnId ?? null);
}

function turnProcessExpansionKey(identity: string): string {
  return `turn-process:${identity}`;
}

function turnByAnyIdentity(turnsByProviderId: NativeSessionState['turnsByProviderId'], identity: string) {
  return turnsByProviderId[identity] ?? Object.values(turnsByProviderId).find((turn) => turn.id === identity || turn.providerTurnId === identity);
}

function defaultExpandedTurnProcessKeys(rows: readonly TranscriptTurnRow[], turnsByProviderId: NativeSessionState['turnsByProviderId'], terminalTurnIds: NativeSessionState['terminalTurnIds']): ReadonlySet<string> {
  /** 运行中与已完成过程统一默认收起，仅异常中断仍主动暴露最后现场。 */
  const expanded = new Set<string>();
  let latestTurnId: string | null = null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    latestTurnId = transcriptTurnRowTurnId(rows[index]!);
    if (latestTurnId) break;
  }
  if (!latestTurnId) return expanded;

  const turn = turnByAnyIdentity(turnsByProviderId, latestTurnId);
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

function transcriptTurnRowTurnId(row: TranscriptViewportRow): string | null {
  if (row.kind === 'navigation_placeholder') return row.entry.providerTurnId ?? row.entry.turnId;
  return row.kind === 'turn_work' || row.kind === 'turn_failure' ? row.turnId : transcriptRowTurnId(row);
}

function transcriptRowContainsItemKey(row: TranscriptRow, itemKey: string | undefined): boolean {
  if (!itemKey || row.kind === 'answered_request') return false;
  return row.kind === 'item' ? row.item.key === itemKey : row.items.some((item) => item.key === itemKey);
}

export function isFinalAnswerItem(item: NativeSessionItemBuffer): boolean {
  return itemRole(item) === 'assistant' && classifyAssistantMessage(item.payload, item.phase) === 'final';
}

function isTurnCompletionOutputItem(item: NativeSessionItemBuffer): boolean {
  // 非正式 plan 已在 isFormalPlanTranscriptItem 中从正式会话投影过滤；能进入这里的 plan
  // 与普通 final answer 一样，都是本轮明确交付给用户的完成态输出。
  return isFinalAnswerItem(item) || normalizeItemType(item.type) === 'plan';
}

/** 持久输入身份跨分页保持不变，缺失时不从时间猜测。 */
function itemOpeningInputId(item: NativeSessionItemBuffer): string | null {
  const value = item.transcript?.placement.openingInputId;
  return typeof value === 'string' && value.trim() ? value : null;
}

/** 新旧记录中的持久思考正文统一作为阶段说明；旧折叠标记不再决定显示样式。 */
function isReasoningProcessText(item: NativeSessionItemBuffer): boolean {
  return normalizeItemType(item.type) === 'reasoning' && [item.payload.reasoningPresentation, recordValue(item.payload.detail)?.reasoningPresentation].some((value) => value === 'process_text' || value === 'details_collapsed');
}

/** 隐藏状态和移入侧栏的协调事件既不渲染，也不打断可见操作的连续性。 */
function isHiddenTranscriptProcessItem(item: NativeSessionItemBuffer): boolean {
  return isSubagentCoordinationItem(item) || (normalizeItemType(item.type) === 'reasoning' && !isReasoningProcessText(item));
}

export function projectTranscriptRows(
  items: readonly NativeSessionItemBuffer[],
  answeredRequests: readonly NativePendingRequest[] = [],
  activeTurnId: string | null = null,
  historyOnly = false,
  terminalTurnIds: NativeSessionState['terminalTurnIds'] = {},
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  /** 问答关系只计算一次，同时决定卡片内容、所在位置和原问题去重。 */
  const questionAnswers = new Map(items.map((item) => [item.key, asyncQuestionAnswerHistory(item, items)]));
  /** 只有能完整展示的有效回答才接管原问题，失败答案保留重新回答入口。 */
  const answeredQuestionIds = new Set(
    items.flatMap((item) => {
      if (!questionAnswers.get(item.key)) return [];
      /** 已校验的结构化身份不使用正文、时间或当前轮次猜测关联。 */
      const answer = item.payload.questionAnswer as AsyncQuestionAnswer;
      return [`${answer.providerTurnId}/${answer.providerItemId}`];
    }),
  );
  const candidateActiveTurnId = historyOnly ? null : activeTurnId && items.some((item) => item.turnId === activeTurnId) ? activeTurnId : latestLiveTurnId(items);
  // Provider 可能在终态到达后仍留下一条 in_progress reasoning；终态表优先，不能把旧摘要重新判成当前执行。
  const effectiveActiveTurnId = candidateActiveTurnId && !terminalTurnIds[candidateActiveTurnId] ? candidateActiveTurnId : null;
  const currentActivityItemKey = latestCurrentActivityItemKey(items, effectiveActiveTurnId);
  const timeline: Array<{ kind: 'item'; item: NativeSessionItemBuffer } | { kind: 'answered_request'; request: NativePendingRequest }> = items.map((item) => ({ kind: 'item', item }));
  for (const request of [...answeredRequests].sort((left, right) => {
    const leftOrder = left.transcript?.placement.order ?? null;
    const rightOrder = right.transcript?.placement.order ?? null;
    if (leftOrder !== null && rightOrder !== null) return leftOrder - rightOrder || left.id.localeCompare(right.id);
    if (leftOrder !== null) return -1;
    if (rightOrder !== null) return 1;
    return left.id.localeCompare(right.id);
  })) {
    // 缺少轮次身份的旧记录不能靠时间猜测归属，也不能重新污染主会话时间线。
    if (!request.turnId) continue;
    const requestOrder = request.transcript?.placement.order ?? null;
    // 已回答询问与正文共用持久位置；旧协议缺少位置时只追加，不再根据时间猜测。
    const insertionIndex = requestOrder === null ? -1 : timeline.findIndex((entry) => entry.kind === 'item' && (entry.item.transcript?.placement.order ?? Number.MAX_SAFE_INTEGER) > requestOrder);
    timeline.splice(insertionIndex < 0 ? timeline.length : insertionIndex, 0, { kind: 'answered_request', request });
  }

  /** 分组只读取持久输入归属；隐藏思考产生的阶段变化不代表可见边界。 */
  const inputIdentityByTimelineIndex = new Map<number, string>();
  /** 同一轮次也不能跨越普通用户插话合并工具活动。 */
  const inputBoundaryByTurn = new Map<string, string>();
  timeline.forEach((entry, index) => {
    if (entry.kind === 'item' && isHiddenTranscriptProcessItem(entry.item)) return;
    const turnId = entry.kind === 'item' ? entry.item.turnId : entry.request.turnId;
    if (!turnId) return;
    const persistentOpeningInputId = entry.kind === 'item' ? itemOpeningInputId(entry.item) : null;
    if (persistentOpeningInputId) inputBoundaryByTurn.set(turnId, persistentOpeningInputId);
    if (entry.kind === 'item' && itemRole(entry.item) === 'user' && !questionAnswers.get(entry.item.key)) {
      inputBoundaryByTurn.set(turnId, persistentOpeningInputId ?? `${turnId}\u0000input:${transcriptItemRenderKey(entry.item)}`);
    }
    /** 缺少持久输入身份的旧记录仍由真实用户消息形成边界。 */
    const inputBoundary = inputBoundaryByTurn.get(turnId) ?? turnId;
    inputIdentityByTimelineIndex.set(index, inputBoundary);
  });

  /** 同一输入下连续可见的操作合并；可见沟通和持久思考正文才切断分组。 */
  const activityRunByStartIndex = new Map<number, { inputIdentity: string; items: NativeSessionItemBuffer[] }>();
  /** 当前组不跨越可见内容，隐藏条目不改变其边界。 */
  let currentActivityRun: { startIndex: number; inputIdentity: string; items: NativeSessionItemBuffer[] } | null = null;
  timeline.forEach((entry, index) => {
    if (entry.kind === 'item' && isHiddenTranscriptProcessItem(entry.item)) return;
    if (entry.kind !== 'item' || !isOperationalActivityItem(entry.item)) {
      currentActivityRun = null;
      return;
    }
    /** 首条操作身份负责唯一性，输入身份负责禁止跨输入合并。 */
    const inputIdentity = inputIdentityByTimelineIndex.get(index) ?? entry.item.turnId;
    if (!currentActivityRun || currentActivityRun.inputIdentity !== inputIdentity) {
      currentActivityRun = { startIndex: index, inputIdentity, items: [] };
      activityRunByStartIndex.set(index, currentActivityRun);
    }
    currentActivityRun.items.push(entry.item);
  });
  for (let index = 0; index < timeline.length; index += 1) {
    const entry = timeline[index]!;
    if (entry.kind === 'answered_request') {
      rows.push({ kind: 'answered_request', key: `answered-request:${entry.request.id}`, request: entry.request });
    } else {
      const item = entry.item;
      // 答案卡片已完整承载原题和选项，不在主会话流重复展示同一个问题。
      if (itemRole(item) === 'assistant' && classifyAssistantMessage(item.payload, item.phase) === 'question' && answeredQuestionIds.has(`${item.turnId}/${item.providerItemId ?? item.itemId}`)) continue;
      // 多智能体协调事件统一进入右侧智能体面板，不在主会话重复暴露协议载荷。
      if (!isHiddenTranscriptProcessItem(item)) {
        /** 分组与渲染使用同一套隐藏规则，不能留下没有说明的空边界。 */
        const inputIdentity = inputIdentityByTimelineIndex.get(index) ?? item.turnId;
        if (!isOperationalActivityItem(item)) {
          rows.push({ kind: 'item', key: transcriptItemRenderKey(item), item, questionAnswer: questionAnswers.get(item.key) });
        } else {
          /** 只有连续组首项负责渲染，后续项仍保留在该组的原始顺序中。 */
          const activityRun = activityRunByStartIndex.get(index);
          if (!activityRun) continue;
          const groupedItems = activityRun.items;
          const categories = new Set(groupedItems.map(activityCategory));
          rows.push({
            kind: 'activity',
            key: `activity:${encodeURIComponent(inputIdentity)}:${encodeURIComponent(transcriptItemRenderKey(groupedItems[0]!))}`,
            items: groupedItems,
            category: categories.size === 1 ? activityCategory(groupedItems[0]!) : 'mixed',
            motionActive: groupedItems.some((candidate) => candidate.key === currentActivityItemKey),
          });
        }
      }
    }
  }
  return rows;
}

/** 活动轮只选择最新的可读思考内容；Codex 摘要和 Pi 过程正文共享同一优先级。 */
function latestActiveReasoningSummaryItem(items: readonly NativeSessionItemBuffer[], activeTurnId: string | null): NativeSessionItemBuffer | null {
  if (!activeTurnId || items.some((item) => item.turnId === activeTurnId && isFinalAnswerItem(item))) return null;
  return [...items].reverse().find((item) => item.turnId === activeTurnId && normalizeItemType(item.type) === 'reasoning' && item.status !== 'failed' && latestReasoningSummaryText(item).length > 0) ?? null;
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

/** 持久思考正文和普通消息保留各自的稳定身份。 */
function transcriptItemRenderKey(item: NativeSessionItemBuffer): string {
  const entryId = item.transcript?.placement.entryId;
  const clientUserMessageId = itemRole(item) === 'user' ? (item.clientUserMessageId ?? item.durableClientUserMessageId) : null;
  // 用户消息的可见身份来自客户端消息 id；Provider 技术条目接管时不能替换整个消息节点。
  return clientUserMessageId ? `user-message:${encodeURIComponent(clientUserMessageId)}` : entryId ? `transcript:${encodeURIComponent(entryId)}` : item.key;
}

/** 共享时间线隐藏内部协作事件与不可读输入，原始记录仍保留在会话状态中。 */
export function isVisibleTranscriptItem(item: NativeSessionItemBuffer): boolean {
  if (isSubagentCoordinationItem(item)) return false;
  if (recordValue(item.payload.subagentInput)?.contentState === 'unavailable') return false;
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
  const projected = [...items];
  for (const plan of planItems) {
    let lastTurnIndex = -1;
    for (let index = 0; index < projected.length; index += 1) {
      if (projected[index]?.turnId === plan.turnId) lastTurnIndex = index;
    }
    projected.splice(lastTurnIndex < 0 ? projected.length : lastTurnIndex + 1, 0, plan);
  }
  return projected;
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

function isComposerQueuedUserItem(item: NativeSessionItemBuffer, submissionIds: ReadonlySet<string>, clientUserMessageIds: ReadonlySet<string>): boolean {
  if (!item.optimistic || itemRole(item) !== 'user') return false;
  /** 提交身份覆盖冷开后由持久队列重建的本地消息。 */
  const itemSubmissionIds = [item.localItemId, item.itemId, transcriptPayloadString(item, 'submissionId')].filter((value): value is string => Boolean(value));
  if (itemSubmissionIds.some((identity) => submissionIds.has(identity))) return true;
  /** 客户端身份覆盖首次入队后尚未补齐提交身份的乐观消息。 */
  return transcriptUserMessageClientIds(item).some((identity) => clientUserMessageIds.has(identity));
}

function queuedSubmissionForItem(item: NativeSessionItemBuffer, queue: NativeQueueSnapshot | null): NativeQueuedSubmission | null {
  const submissionIds = [item.localItemId, item.itemId, primitiveValue(item.payload.submissionId)].filter((value): value is string => Boolean(value));
  if (submissionIds.length === 0) return null;
  const identities = new Set(submissionIds);
  return queue?.submissions.find((submission) => identities.has(submission.id)) ?? null;
}

/**
 * Provider 轮次建立前就暂停的提交同样是已落库历史。它们不能只存在于队列状态里，
 * 否则冷开会话会过滤掉乐观消息，并把用户已经发送的内容渲染成整页空白。
 */
/** 从当前权威队列即时派生展示，删除后不保留任何正文副本。 */
export function projectQueuedSubmissionItems(state: NativeSessionState, submissions: ReturnType<typeof visibleQueuedSubmissions>, persistedItems: readonly NativeSessionItemBuffer[]): NativeSessionItemBuffer[] {
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
    const timestamp = submission.createdAt ?? '';
    const deliveryError = submission.error
      ? {
          code: submission.error.code,
          ...(submission.error.cause ? { cause: userFacingErrorCause(submission.error.cause) } : {}),
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
          // 冷开与实时发送使用同一份题目和答案，不能把结构化回答恢复成普通引导消息。
          ...(submission.questionAnswer ? { questionAnswer: submission.questionAnswer } : {}),
          ...(submission.attachments?.length ? { attachments: submission.attachments } : {}),
          ...(submission.browserComments?.length ? { browserComments: submission.browserComments } : {}),
          ...(submission.conversationContext ? { conversationContext: submission.conversationContext } : {}),
          ...(deliveryError ? { deliveryError } : {}),
        },
        resources: [],
        optimistic: true,
        ...(submission.clientUserMessageId ? { clientUserMessageId: submission.clientUserMessageId, durableClientUserMessageId: submission.clientUserMessageId } : {}),
        messageCreatedAt: submission.createdAt,
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
  if (hasUnclaimedRecoveredRequestUserInput(state)) return false;
  if (state.conversationState === 'starting_turn') return true;
  const effectiveActiveTurnId = state.activeTurnId && items.some((item) => item.turnId === state.activeTurnId) ? state.activeTurnId : latestLiveTurnId(items);
  if (!effectiveActiveTurnId) return true;
  return !items.some((item) => item.turnId === effectiveActiveTurnId && itemProvidesCurrentModelStatus(item, state));
}

function itemProvidesCurrentModelStatus(item: NativeSessionItemBuffer, state: NativeSessionState): boolean {
  // 只有“模型当前在做什么”的思考摘要或已经开始的最终回答可以替代底部状态行；
  // 命令、文件、网页和技能只是过程明细，不能让进行中状态消失。
  if (normalizeItemType(item.type) === 'reasoning' && reasoningSummaryStatus(item, state) === 'active' && latestReasoningSummaryText(item).length > 0) return true;
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
