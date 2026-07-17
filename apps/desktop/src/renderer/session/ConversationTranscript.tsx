import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ThreadItemView, itemRole, transcriptItemText, type SessionUiLanguage } from './ThreadItemView.js';
import type { NativePendingRequest, NativeSessionItemBuffer, NativeSessionState } from './sessionTypes.js';
import { useThreadScrollController } from './useThreadScrollController.js';

export interface ConversationTranscriptProps {
  state: NativeSessionState;
  language: SessionUiLanguage;
  onEditUserItem?: (item: NativeSessionItemBuffer) => void;
  onRetryItem?: (item: NativeSessionItemBuffer) => void;
  pendingRequests?: NativePendingRequest[];
  renderPendingRequest?: (request: NativePendingRequest, index: number) => ReactNode;
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
  const items = useMemo(() => props.state.itemOrder.map((key) => props.state.items[key]).filter((entry): entry is NativeSessionItemBuffer => Boolean(entry) && isVisibleTranscriptItem(entry)), [props.state.itemOrder, props.state.items]);
  const lastUserKey = [...items].reverse().find((entry) => `${entry.type}`.toLocaleLowerCase().includes('user'))?.key;
  const pendingRequests = props.pendingRequests ?? [];
  const anchoredRequests = useMemo(() => anchorPendingRequests(items, pendingRequests), [items, pendingRequests]);
  const requestsById = useMemo(() => new Map(pendingRequests.map((request) => [request.id, request])), [pendingRequests]);
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
    const effect = scrollController.onDelta(metrics(container), Date.now());
    if (effect.type !== 'scroll_to_bottom') return;
    container.scrollTo({ top: container.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
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
          {items.length > 0 ? (
            items.map((entry, index) => (
              <Fragment key={entry.key}>
                <ThreadItemView item={entry} language={props.language} isLatest={index === items.length - 1 && !showThinking} isLatestUser={entry.key === lastUserKey} onEdit={props.onEditUserItem} onRetry={props.onRetryItem} />
                {(anchoredRequests.afterItem[entry.key] ?? []).map((requestId) => {
                  const request = requestsById.get(requestId);
                  return request ? <Fragment key={request.id}>{props.renderPendingRequest?.(request, pendingRequests.indexOf(request))}</Fragment> : null;
                })}
              </Fragment>
            ))
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
        </section>
        {returnToLatestVisible ? (
          <button
            type="button"
            className="session-return-latest"
            onClick={() => {
              const container = containerRef.current;
              if (!container) return;
              container.scrollTo({ top: container.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
              setReturnToLatestVisible(false);
            }}
          >
            {props.language === 'zh-CN' ? '返回最新消息' : 'Return to latest'}
          </button>
        ) : null}
      </div>
    </>
  );
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
