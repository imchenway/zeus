import { memo, useLayoutEffect } from 'react';
import type { ConversationState, NativeSessionItemBuffer } from './sessionTypes.js';
import { type SessionUiLanguage, useAdaptiveTranscriptText } from './ThreadItemView.js';

export type ReasoningSummaryStatus = 'active' | 'waiting' | 'completed' | 'failed' | 'interrupted';

export const SessionReasoningSummary = memo(function SessionReasoningSummary(props: {
  item: NativeSessionItemBuffer;
  language: SessionUiLanguage;
  status: ReasoningSummaryStatus;
  motionActive?: boolean;
  onVisibleContentChange?: () => void;
}) {
  const sourceText = latestReasoningSummaryText(props.item);
  const adaptiveText = useAdaptiveTranscriptText(sourceText, props.status === 'active');
  useLayoutEffect(() => {
    if (adaptiveText.revision > 0) props.onVisibleContentChange?.();
  }, [adaptiveText.revision, props.onVisibleContentChange]);
  if (!sourceText) return null;
  const statusLabel = reasoningStatusLabel(props.status, props.language);

  return (
    <p className="session-reasoning-summary" data-status={props.status} data-motion-active={props.motionActive || undefined} aria-label={`${statusLabel}：${sourceText}`}>
      <span className="session-sr-only" role="status" aria-live="polite">
        {statusLabel}
      </span>
      <span className="zeus-fidelity-text">{adaptiveText.text}</span>
    </p>
  );
});

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
  // Provider 可能把连续更新的多个动作标题合并进同一摘要项。活动区只应表达
  // 最新动作，否则一个转圈图标会带出两三行“同时进行中”的错觉。
  const latest = text
    .split(/\n\s*\n/gu)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .at(-1)!;
  const bold = /^\*\*([^\n]+)\*\*$/u.exec(latest);
  return bold?.[1] ?? latest;
}

function reasoningStatusLabel(status: ReasoningSummaryStatus, language: SessionUiLanguage): string {
  if (language === 'zh-CN') {
    if (status === 'active') return '正在生成思考摘要';
    if (status === 'waiting') return '思考摘要等待继续';
    if (status === 'failed') return '思考摘要生成失败';
    if (status === 'interrupted') return '思考摘要已中断';
    return '思考摘要';
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
