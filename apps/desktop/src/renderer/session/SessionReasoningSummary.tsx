import { memo, useLayoutEffect } from 'react';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleIcon as Circle } from '@phosphor-icons/react/dist/csr/Circle';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { StopCircleIcon as StopCircle } from '@phosphor-icons/react/dist/csr/StopCircle';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import type { ConversationState, NativeSessionItemBuffer } from './sessionTypes.js';
import { type SessionUiLanguage, useAdaptiveTranscriptText } from './ThreadItemView.js';

export type ReasoningSummaryStatus = 'active' | 'waiting' | 'completed' | 'failed' | 'interrupted';

export const SessionReasoningSummary = memo(function SessionReasoningSummary(props: { item: NativeSessionItemBuffer; language: SessionUiLanguage; status: ReasoningSummaryStatus; onVisibleContentChange?: () => void }) {
  const sourceText = latestReasoningSummaryText(props.item);
  const adaptiveText = useAdaptiveTranscriptText(sourceText, props.status === 'active');
  useLayoutEffect(() => {
    if (adaptiveText.revision > 0) props.onVisibleContentChange?.();
  }, [adaptiveText.revision, props.onVisibleContentChange]);
  if (!sourceText) return null;
  const StatusIcon = reasoningStatusIcon(props.status);
  const statusLabel = reasoningStatusLabel(props.status, props.language);

  return (
    <p className="session-reasoning-summary" data-status={props.status} aria-label={`${statusLabel}：${sourceText}`}>
      <span className="session-sr-only" role="status" aria-live="polite">
        {statusLabel}
      </span>
      <span className="session-reasoning-summary-icon" aria-hidden="true">
        <StatusIcon weight={props.status === 'completed' ? 'fill' : 'regular'} />
      </span>
      <span className="zeus-fidelity-text">{adaptiveText.text}</span>
    </p>
  );
});

export function latestReasoningItemsByTurn(items: readonly NativeSessionItemBuffer[], activeTurnId: string | null = null): NativeSessionItemBuffer[] {
  const latestKeyByTurn = new Map<string, string>();
  for (const item of items) {
    if (isReasoningItem(item) && latestReasoningSummaryText(item)) latestKeyByTurn.set(item.turnId, item.key);
  }
  const projectedItems = items.filter((item) => !isReasoningItem(item) || latestKeyByTurn.get(item.turnId) === item.key);
  if (!activeTurnId) return projectedItems;

  const activeReasoningIndex = projectedItems.findIndex((item) => item.turnId === activeTurnId && isReasoningItem(item));
  if (activeReasoningIndex < 0) return projectedItems;

  let lastActiveTurnItemIndex = activeReasoningIndex;
  for (let index = activeReasoningIndex + 1; index < projectedItems.length; index += 1) {
    if (projectedItems[index]!.turnId === activeTurnId) lastActiveTurnItemIndex = index;
  }
  if (lastActiveTurnItemIndex === activeReasoningIndex) return projectedItems;

  const reorderedItems = [...projectedItems];
  const [activeReasoningItem] = reorderedItems.splice(activeReasoningIndex, 1);
  reorderedItems.splice(lastActiveTurnItemIndex, 0, activeReasoningItem!);
  return reorderedItems;
}

export function latestReasoningSummaryText(item: NativeSessionItemBuffer): string {
  const presentation = recordValue(item.payload.presentation);
  const presentedSegments = stringSegments(presentation.summarySegments);
  const summarySegments = presentedSegments.length > 0 ? presentedSegments : stringSegments(item.payload.summary);
  return cleanReasoningSummary(summarySegments.at(-1) ?? item.text);
}

export function reasoningSummaryStatus(
  item: NativeSessionItemBuffer,
  state: { activeTurnId: string | null; conversationState: ConversationState; terminalTurnIds: Record<string, 'completed' | 'interrupted' | 'failed'> },
): ReasoningSummaryStatus {
  const terminal = state.terminalTurnIds[item.turnId];
  if (terminal) return terminal;
  if (item.status === 'failed') return 'failed';
  if (state.activeTurnId !== item.turnId) return 'completed';
  if (state.conversationState === 'waiting_approval' || state.conversationState === 'waiting_user_input' || state.conversationState === 'interrupt_confirm') return 'waiting';
  return 'active';
}

function isReasoningItem(item: NativeSessionItemBuffer): boolean {
  return item.type.toLocaleLowerCase().replace(/[\s_\-/]+/gu, '') === 'reasoning';
}

function stringSegments(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) return [entry];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const text = (entry as Record<string, unknown>).text;
    return typeof text === 'string' && text.trim() ? [text] : [];
  });
}

function cleanReasoningSummary(value: string): string {
  const text = value.trim();
  if (!text) return '';
  const bold = /^\*\*([^\n]+)\*\*$/u.exec(text);
  return bold?.[1] ?? value;
}

function reasoningStatusIcon(status: ReasoningSummaryStatus) {
  if (status === 'active') return CircleNotch;
  if (status === 'completed') return CheckCircle;
  if (status === 'failed') return WarningCircle;
  if (status === 'interrupted') return StopCircle;
  return Circle;
}

function reasoningStatusLabel(status: ReasoningSummaryStatus, language: SessionUiLanguage): string {
  if (language === 'zh-CN') {
    if (status === 'active') return '思考中';
    if (status === 'waiting') return '等待继续';
    if (status === 'failed') return '思考失败';
    if (status === 'interrupted') return '思考已中断';
    return '思考完成';
  }
  if (status === 'active') return 'Thinking';
  if (status === 'waiting') return 'Waiting to continue';
  if (status === 'failed') return 'Reasoning failed';
  if (status === 'interrupted') return 'Reasoning interrupted';
  return 'Reasoning completed';
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
