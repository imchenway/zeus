import { memo, useLayoutEffect } from 'react';
import type { NativeSessionItemBuffer, NativeSessionState } from './sessionTypes.js';
import { type SessionUiLanguage, useAdaptiveTranscriptText } from './ThreadItemView.js';
import { latestReasoningSummaryText } from './reasoningSummary.js';
import { SessionSweepText } from './SessionSweepText.js';

export type ReasoningSummaryStatus = 'active' | 'waiting' | 'completed' | 'failed' | 'interrupted';

export const SessionReasoningSummary = memo(function SessionReasoningSummary(props: {
  item: NativeSessionItemBuffer;
  language: SessionUiLanguage;
  status: ReasoningSummaryStatus;
  motionActive?: boolean;
  onVisibleContentChange?: () => void;
}) {
  const sourceText = latestReasoningSummaryText(props.item);
  // 快照中的摘要已完整取得，只有后续实时增量需要分批显示。
  const adaptiveText = useAdaptiveTranscriptText(sourceText, props.status === 'active' && props.item.payload.v2SnapshotContentComplete !== true);
  useLayoutEffect(() => {
    if (adaptiveText.revision > 0) props.onVisibleContentChange?.();
  }, [adaptiveText.revision, props.onVisibleContentChange]);
  if (!sourceText) return null;
  const statusLabel = reasoningStatusLabel(props.status, props.language);

  return (
    <p className="session-reasoning-summary" data-status={props.status} data-motion-active={props.motionActive || undefined} aria-label={`${statusLabel}：${sourceText}`}>
      <SessionSweepText className="zeus-fidelity-text" text={adaptiveText.text} active={props.status === 'active'} />
    </p>
  );
});

export function reasoningSummaryStatus(item: NativeSessionItemBuffer, state: Pick<NativeSessionState, 'activeTurnId' | 'conversationState' | 'queue' | 'terminalTurnIds'>): ReasoningSummaryStatus {
  const terminal = state.terminalTurnIds[item.turnId];
  if (terminal) return terminal;
  if (item.status === 'failed') return 'failed';
  if (state.activeTurnId !== item.turnId) return 'completed';
  if (state.queue?.state.type === 'paused' && state.queue.state.reason === 'interaction_authority_missing') return 'waiting';
  if (state.conversationState === 'waiting_approval' || state.conversationState === 'waiting_user_input' || state.conversationState === 'interrupt_confirm') return 'waiting';
  return 'active';
}

/** 历史过程保留摘要内容，活动语义统一使用执行状态。 */
function reasoningStatusLabel(status: ReasoningSummaryStatus, language: SessionUiLanguage): string {
  if (language === 'zh-CN') {
    if (status === 'active') return '正在执行';
    if (status === 'waiting') return '思考摘要等待继续';
    if (status === 'failed') return '思考摘要生成失败';
    if (status === 'interrupted') return '思考摘要已中断';
    return '思考摘要';
  }
  if (status === 'active') return 'Executing';
  if (status === 'waiting') return 'Waiting to continue';
  if (status === 'failed') return 'Reasoning failed';
  if (status === 'interrupted') return 'Reasoning interrupted';
  return 'Reasoning completed';
}
