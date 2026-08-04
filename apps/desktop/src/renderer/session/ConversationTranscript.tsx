import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isOperationalActivityItem, SessionActivityGroup, SessionTurnDuration } from './SessionActivity.js';
import { itemRole, type SessionUiLanguage, ThreadItemView, transcriptItemText } from './ThreadItemView.js';
import { PlanSummary } from './PlanSummary.js';
import type { ConversationResource, NativeSessionItemBuffer, NativeSessionState, TurnChangeSet, TurnChangeSetOperationResult } from './sessionTypes.js';
import type { ConversationFileLocation, ConversationOpenTarget } from '@zeus/shared';
import { useThreadScrollController } from './useThreadScrollController.js';
import { TurnChangeCard } from './TurnChanges.js';
import { latestReasoningItemsByTurn, reasoningSummaryStatus, SessionReasoningSummary } from './SessionReasoningSummary.js';

export interface ConversationTranscriptProps {
  state: NativeSessionState;
  language: SessionUiLanguage;
  onEditUserItem?: (item: NativeSessionItemBuffer, content: string) => void | Promise<void>;
  onRetryItem?: (item: NativeSessionItemBuffer) => void;
  openPlanItemId?: string | null;
  onOpenPlan?: (item: NativeSessionItemBuffer) => void;
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
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
  const items = useMemo(
    () => latestReasoningItemsByTurn(props.state.itemOrder.map((key) => props.state.items[key]).filter((entry): entry is NativeSessionItemBuffer => Boolean(entry) && isVisibleTranscriptItem(entry))),
    [props.state.itemOrder, props.state.items],
  );
  const lastUserKey = [...items].reverse().find((entry) => `${entry.type}`.toLocaleLowerCase().includes('user'))?.key;
  const lastAssistantKey = [...items].reverse().find((entry) => itemRole(entry) === 'assistant')?.key;
  const transcriptRows = useMemo(() => projectTranscriptRows(items), [items]);
  const lastItemKeyByTurn = useMemo(() => Object.fromEntries(items.map((item) => [item.turnId, item.key])), [items]);
  const showThinking = shouldShowTranscriptThinking(props.state);
  const historyHydrated = props.state.snapshot !== null;
  const historyUnavailable = !historyHydrated && (props.state.transportState === 'reconnecting' || props.state.transportState === 'failed');

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
            transcriptRows.map((row) => {
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
                      />
                    )
                  ) : (
                    <SessionActivityGroup items={row.items} language={props.language} />
                  )}
                  {closesVisibleTurn && changeSet && changeSet.state !== 'capturing' && (changeSet.fileCount > 0 || changeSet.state === 'conflicted') ? (
                    <TurnChangeCard changeSet={changeSet} language={props.language} onReview={props.onReviewTurnChanges} onOperate={props.onOperateTurnChangeSet} />
                  ) : null}
                  {closesVisibleTurn && turn ? <SessionTurnDuration turn={turn} language={props.language} /> : null}
                </Fragment>
              );
            })
          ) : !showThinking && historyHydrated ? (
            <p className="session-transcript-empty">{props.language === 'zh-CN' ? '发送第一条消息后，真实 app-server 对话会显示在这里。' : 'Send the first message to begin the real app-server transcript.'}</p>
          ) : !showThinking && historyUnavailable ? (
            <p className="session-transcript-empty" role="status">
              {props.language === 'zh-CN' ? '历史消息暂不可用；连接恢复后会自动显示。' : 'History is temporarily unavailable and will reappear after the connection recovers.'}
            </p>
          ) : null}
          {showThinking ? (
            <p className="session-transcript-thinking" role="status" aria-live="polite">
              <span className="session-thinking-pulse" aria-hidden="true" />
              {props.language === 'zh-CN' ? '正在思考' : 'Thinking'}
            </p>
          ) : null}
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
              behavior: prefersReducedMotion() ? 'auto' : 'smooth',
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

export type TranscriptRow =
  | { kind: 'item'; key: string; item: NativeSessionItemBuffer }
  | {
      kind: 'activity';
      key: string;
      items: NativeSessionItemBuffer[];
    };

export function projectTranscriptRows(items: readonly NativeSessionItemBuffer[]): TranscriptRow[] {
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
  for (const item of items) {
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
    if (shouldPosition()) container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
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
