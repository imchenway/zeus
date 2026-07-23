import {Fragment, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {isOperationalActivityItem, SessionActivityGroup, SessionTurnDuration} from './SessionActivity.js';
import {itemRole, type SessionUiLanguage, ThreadItemView, transcriptItemText} from './ThreadItemView.js';
import {PlanSummary} from './PlanSummary.js';
import type {
    NativePendingRequest,
    NativePlanImplementationRequest,
    NativeSessionItemBuffer,
    NativeSessionState
} from './sessionTypes.js';
import {useThreadScrollController} from './useThreadScrollController.js';

export interface ConversationTranscriptProps {
  state: NativeSessionState;
  language: SessionUiLanguage;
    onEditUserItem?: (item: NativeSessionItemBuffer, content: string) => void | Promise<void>;
  onRetryItem?: (item: NativeSessionItemBuffer) => void;
  pendingRequests?: NativePendingRequest[];
  renderPendingRequest?: (request: NativePendingRequest, index: number) => ReactNode;
    planImplementationRequests?: NativePlanImplementationRequest[];
    renderPlanImplementationRequest?: (request: NativePlanImplementationRequest, index: number) => ReactNode;
    openPlanItemId?: string | null;
    onOpenPlan?: (item: NativeSessionItemBuffer) => void;
}

export function ConversationTranscript(props: ConversationTranscriptProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const previousTurnIdRef = useRef<string | null>(null);
  const pendingTurnPositionRef = useRef(false);
    const previousRequestSurfaceRevisionRef = useRef('');
  const scrollController = useThreadScrollController();
  const [returnToLatestVisible, setReturnToLatestVisible] = useState(false);
  const [turnSpacerHeight, setTurnSpacerHeight] = useState(0);
  const [completedAnnouncement, setCompletedAnnouncement] = useState<{ key: string; text: string } | null>(null);
  const completedAnnouncementTrackerRef = useRef<CompletedItemAnnouncementTracker>({ hydrated: false, lastCompletedKey: null });
  const items = useMemo(() => props.state.itemOrder.map((key) => props.state.items[key]).filter((entry): entry is NativeSessionItemBuffer => Boolean(entry) && isVisibleTranscriptItem(entry)), [props.state.itemOrder, props.state.items]);
  const lastUserKey = [...items].reverse().find((entry) => `${entry.type}`.toLocaleLowerCase().includes('user'))?.key;
    const lastAssistantKey = [...items].reverse().find((entry) => itemRole(entry) === 'assistant')?.key;
    // Codex App 只展开队首请求；后续请求保留在权威快照中，待前一项解决后再展示。
    const pendingRequests = (props.pendingRequests ?? []).slice(0, 1);
  const anchoredRequests = useMemo(() => anchorPendingRequests(items, pendingRequests), [items, pendingRequests]);
  const requestsById = useMemo(() => new Map(pendingRequests.map((request) => [request.id, request])), [pendingRequests]);
    const planRequests = props.planImplementationRequests ?? [];
    const requestSurfaceRevision = [...pendingRequests.map((request) => `${request.id}:${request.status}`), ...planRequests.map((request) => `${request.id}:${request.status}`)].join('|');
    const planRequestsByItem = useMemo(() => {
        const result: Record<string, NativePlanImplementationRequest[]> = {};
        for (const request of planRequests) {
            const item = items.find((candidate) => candidate.localItemId === request.planItemId || candidate.itemId === request.planItemId);
            if (item) (result[item.key] ??= []).push(request);
        }
        return result;
    }, [items, planRequests]);
    const anchoredPlanRequestIds = useMemo(() => new Set(Object.values(planRequestsByItem).flatMap((requests) => requests.map((request) => request.id))), [planRequestsByItem]);
    const transcriptRows = useMemo(() => projectTranscriptRows(items, anchoredRequests.afterItem), [anchoredRequests.afterItem, items]);
    const lastItemKeyByTurn = useMemo(() => Object.fromEntries(items.map((item) => [item.turnId, item.key])), [items]);
  const showThinking = shouldShowTranscriptThinking(props.state, items);

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
      const interactionSurfaceAdded = Boolean(requestSurfaceRevision) && requestSurfaceRevision !== previousRequestSurfaceRevisionRef.current;
      previousRequestSurfaceRevisionRef.current = requestSurfaceRevision;
      const effect = interactionSurfaceAdded ? scrollController.onInteractionSurfaceAdded() : scrollController.onDelta(metrics(container), Date.now());
    if (effect.type !== 'scroll_to_bottom') return;
    container.scrollTo({ top: container.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [props.state.transcriptRevision, requestSurfaceRevision, scrollController]);

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
          {items.length > 0 ? (
              transcriptRows.map((row) => {
                  const rowItems = row.kind === 'item' ? [row.item] : row.items;
                  const lastRowItem = rowItems[rowItems.length - 1]!;
                  const turn = props.state.turnsByProviderId[lastRowItem.turnId];
                  const closesVisibleTurn = lastItemKeyByTurn[lastRowItem.turnId] === lastRowItem.key;
                  return (
                      <Fragment key={row.key}>
                          {row.kind === 'item' ? (
                              row.item.type === 'plan' ? (
                                  <PlanSummary item={row.item} language={props.language}
                                               panelOpen={props.openPlanItemId === (row.item.localItemId ?? row.item.itemId)}
                                               onOpenPanel={props.onOpenPlan}/>
                              ) : (
                                  <ThreadItemView
                                      item={row.item}
                                      language={props.language}
                                      isLatest={row.item.key === items[items.length - 1]?.key && !showThinking}
                                      showAssistantActions={row.item.key === lastAssistantKey && !showThinking}
                                      isLatestUser={row.item.key === lastUserKey}
                                      onEdit={props.onEditUserItem}
                                      onRetry={props.onRetryItem}
                                  />
                              )
                          ) : (
                              <SessionActivityGroup items={row.items} language={props.language}/>
                          )}
                          {rowItems
                              .flatMap((entry) => anchoredRequests.afterItem[entry.key] ?? [])
                              .map((requestId) => {
                                  const request = requestsById.get(requestId);
                                  return request ? <Fragment
                                      key={request.id}>{props.renderPendingRequest?.(request, pendingRequests.indexOf(request))}</Fragment> : null;
                              })}
                          {rowItems
                              .flatMap((entry) => planRequestsByItem[entry.key] ?? [])
                              .map((request) => (
                                  <Fragment
                                      key={request.id}>{props.renderPlanImplementationRequest?.(request, planRequests.indexOf(request))}</Fragment>
                              ))}
                          {closesVisibleTurn && turn ?
                              <SessionTurnDuration turn={turn} language={props.language}/> : null}
                      </Fragment>
                  );
              })
          ) : !showThinking ? (
            <p className="session-transcript-empty">{props.language === 'zh-CN' ? '发送第一条消息后，真实 app-server 对话会显示在这里。' : 'Send the first message to begin the real app-server transcript.'}</p>
          ) : null}
          {showThinking ? (
            <p className="session-transcript-thinking" role="status" aria-live="polite">
              <span className="session-thinking-pulse" aria-hidden="true" />
              {props.language === 'zh-CN' ? '正在思考' : 'Thinking'}
            </p>
          ) : null}
          {turnSpacerHeight > 0 && props.state.activeTurnId ? <span className="session-latest-turn-spacer" style={{ blockSize: `${turnSpacerHeight}px` }} aria-hidden="true" /> : null}
          {anchoredRequests.tail.map((requestId) => {
            const request = requestsById.get(requestId);
            return request ? (
              <section className="session-pending-request-fallback" data-request-id={request.id} key={request.id}>
                <p className="session-pending-request-fallback-id">
                  <span>{props.language === 'zh-CN' ? '请求 ID' : 'Request ID'}</span> <code>{request.id}</code>
                </p>
                {props.renderPendingRequest?.(request, pendingRequests.indexOf(request))}
              </section>
            ) : null;
          })}
            {planRequests
                .filter((request) => !anchoredPlanRequestIds.has(request.id))
                .map((request) => (
                    <Fragment
                        key={request.id}>{props.renderPlanImplementationRequest?.(request, planRequests.indexOf(request))}</Fragment>
                ))}
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
                      behavior: prefersReducedMotion() ? 'auto' : 'smooth'
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

export type TranscriptRow = { kind: 'item'; key: string; item: NativeSessionItemBuffer } | {
    kind: 'activity';
    key: string;
    items: NativeSessionItemBuffer[]
};

export function projectTranscriptRows(items: readonly NativeSessionItemBuffer[], afterItem: Record<string, string[]> = {}): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    let activity: NativeSessionItemBuffer[] = [];
    const flushActivity = () => {
        if (activity.length === 0) return;
        rows.push({
            kind: 'activity',
            key: `activity:${activity[0]!.key}:${activity[activity.length - 1]!.key}`,
            items: activity
        });
        activity = [];
    };
    for (const item of items) {
        if (!isOperationalActivityItem(item)) {
            flushActivity();
            rows.push({kind: 'item', key: item.key, item});
            continue;
        }
        if (activity.length > 0 && activity[activity.length - 1]!.turnId !== item.turnId) flushActivity();
        activity.push(item);
        if ((afterItem[item.key] ?? []).length > 0) flushActivity();
    }
    flushActivity();
    return rows;
}

export function isVisibleTranscriptItem(item: NativeSessionItemBuffer): boolean {
  if (itemRole(item) !== 'commentary') return true;
  return transcriptItemText(item).trim().length > 0;
}

export function shouldShowTranscriptThinking(state: NativeSessionState, items: readonly NativeSessionItemBuffer[]): boolean {
  if (state.conversationState !== 'starting_turn' && state.conversationState !== 'active_prework' && state.conversationState !== 'active_final_answer') return false;
  if (!state.activeTurnId) return true;
  return !items.some((item) => item.turnId === state.activeTurnId && itemRole(item) !== 'user');
}

export function anchorPendingRequests(items: readonly NativeSessionItemBuffer[], requests: readonly NativePendingRequest[]): { afterItem: Record<string, string[]>; tail: string[] } {
  const afterItem: Record<string, string[]> = {};
  const tail: string[] = [];
  const tupleItemIndex = new Map<string, number>();
  const uniqueItemIndex = new Map<string, number | null>();
  const lastTurnIndex = new Map<string, number>();
  const recordItemIdentity = (turnId: string, itemId: string | undefined, index: number) => {
    if (!itemId) return;
    tupleItemIndex.set(itemIdentityKey(turnId, itemId), index);
    const previous = uniqueItemIndex.get(itemId);
    uniqueItemIndex.set(itemId, previous === undefined || previous === index ? index : null);
  };
  items.forEach((item, index) => {
    recordItemIdentity(item.turnId, item.itemId, index);
    recordItemIdentity(item.turnId, item.localItemId, index);
    lastTurnIndex.set(item.turnId, index);
  });
  for (const request of requests) {
    const directIndex = request.itemId ? (request.turnId ? tupleItemIndex.get(itemIdentityKey(request.turnId, request.itemId)) : (uniqueItemIndex.get(request.itemId) ?? undefined)) : undefined;
    const itemIndex = directIndex ?? (request.turnId ? lastTurnIndex.get(request.turnId) : undefined);
    const item = itemIndex === undefined ? undefined : items[itemIndex];
    if (!item) {
      tail.push(request.id);
      continue;
    }
    (afterItem[item.key] ??= []).push(request.id);
  }
  return { afterItem, tail };
}

function itemIdentityKey(turnId: string, itemId: string): string {
  return `${turnId}\u0000${itemId}`;
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
    if (shouldPosition()) container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
  });
  return () => {
    if (typeof window !== 'undefined') window.cancelAnimationFrame(frameId);
  };
}

function metrics(element: HTMLElement) {
  return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
