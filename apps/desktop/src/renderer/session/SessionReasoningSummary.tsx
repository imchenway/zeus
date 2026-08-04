import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleIcon as Circle } from '@phosphor-icons/react/dist/csr/Circle';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { StopCircleIcon as StopCircle } from '@phosphor-icons/react/dist/csr/StopCircle';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import type { ConversationState, NativeSessionItemBuffer } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

export type ReasoningSummaryStatus = 'active' | 'waiting' | 'completed' | 'failed' | 'interrupted';

export function SessionReasoningSummary(props: { item: NativeSessionItemBuffer; language: SessionUiLanguage; status: ReasoningSummaryStatus }) {
  const text = latestReasoningSummaryText(props.item);
  if (!text) return null;
  const StatusIcon = reasoningStatusIcon(props.status);
  const statusLabel = reasoningStatusLabel(props.status, props.language);
  const live = props.status === 'active';

  return (
    <p className="session-reasoning-summary" data-status={props.status} aria-label={`${statusLabel}：${text}`} {...(live ? { role: 'status', 'aria-live': 'polite' as const, 'aria-atomic': true } : {})}>
      <span className="session-reasoning-summary-icon" aria-hidden="true">
        <StatusIcon weight={props.status === 'completed' ? 'fill' : 'regular'} />
      </span>
      <span>{text}</span>
    </p>
  );
}

export function latestReasoningItemsByTurn(items: readonly NativeSessionItemBuffer[]): NativeSessionItemBuffer[] {
  const latestKeyByTurn = new Map<string, string>();
  for (const item of items) {
    if (isReasoningItem(item) && latestReasoningSummaryText(item)) latestKeyByTurn.set(item.turnId, item.key);
  }
  return items.filter((item) => !isReasoningItem(item) || latestKeyByTurn.get(item.turnId) === item.key);
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
  const bold = /^\*\*([^\n]+)\*\*$/u.exec(text);
  return (bold?.[1] ?? text).trim();
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
