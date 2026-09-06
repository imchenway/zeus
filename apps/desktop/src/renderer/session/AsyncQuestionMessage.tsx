import { useEffect, useMemo, useState } from 'react';
import { asyncMessageQuestions, classifyAssistantMessage, type AsyncQuestionAnswer, type AsyncQuestionResponse } from '@zeus/shared';
import { clearRuiDraft, normalizeRequestQuestions, RequestUserInputPanel } from './PendingRequestSurface.js';
import { itemRole, ThreadItemView, type SessionUiLanguage } from './ThreadItemView.js';
import type { NativeSessionItemBuffer, NativeSessionState } from './sessionTypes.js';

/** 通过原问题身份寻找答复，不把相同文字或别的轮次当作已回答证据。 */
export function asyncQuestionReply(item: NativeSessionItemBuffer, state: NativeSessionState): NativeSessionItemBuffer | undefined {
  return Object.values(state.items).find((candidate) => {
    const answer = candidate.payload.questionAnswer as AsyncQuestionAnswer | undefined;
    return itemRole(candidate) === 'user' && answer?.providerItemId === (item.providerItemId ?? item.itemId) && answer.providerTurnId === item.turnId && !['failed', 'cancelled', 'deleted'].includes(candidate.status);
  });
}

/** 异步问题的可定位入口供运行状态和时间线共同使用。 */
export function asyncQuestionAnchor(item: NativeSessionItemBuffer): string {
  return `async-question-${encodeURIComponent(item.key)}`;
}

/** 复用问题表单与普通引导通道；异步询问不产生阻塞性请求或审批权限。 */
export function AsyncQuestionMessage(props: {
  item: NativeSessionItemBuffer;
  state: NativeSessionState;
  language: SessionUiLanguage;
  onAnswer?: (item: NativeSessionItemBuffer, answers: AsyncQuestionAnswer['answers'], asNewMessage: boolean) => Promise<void>;
}) {
  const { item, state, language } = props;
  const zh = language === 'zh-CN';
  const questions = useMemo(() => normalizeRequestQuestions({ payload: { questions: asyncMessageQuestions(item.payload) } }), [item.payload]);
  const requestId = `${item.conversationId}/${item.turnId}/${item.providerItemId ?? item.itemId}`;
  const reply = asyncQuestionReply(item, state);
  const response = item.payload.questionResponse as AsyncQuestionResponse | undefined;
  const confirmed = Boolean((reply && !reply.optimistic && reply.providerItemId && reply.status === 'completed') || response?.status === 'resolved' || response?.status === 'completed');
  const pending = Boolean((reply || response) && !confirmed);
  // 接收、排队和未知送达分别显示，不能将恢复中的答复画成持续执行。
  const deliveryStatus = response?.status ?? reply?.status;
  const pendingLabel = ['paused', 'unconfirmed'].includes(deliveryStatus ?? '')
    ? zh
      ? '回答送达尚未确认，请恢复会话'
      : 'Answer delivery is unconfirmed. Recover the conversation.'
    : deliveryStatus === 'queued'
      ? zh
        ? '回答已作为新消息排队'
        : 'Answer queued as a new message'
      : zh
        ? '回答已提交，正在确认送达'
        : 'Answer submitted, confirming delivery';
  const [expanded, setExpanded] = useState(() => state.activeTurnId === item.turnId);
  const [error, setError] = useState<string | null>(null);
  const [rejectedTurn, setRejectedTurn] = useState(false);
  const turn = state.turnsByProviderId[item.turnId];
  const closed =
    rejectedTurn ||
    Boolean(state.terminalTurnIds[item.turnId]) ||
    Boolean(turn?.completedAt) ||
    Object.values(state.items).some((candidate) => candidate.turnId === item.turnId && itemRole(candidate) === 'assistant' && candidate.status === 'completed' && classifyAssistantMessage(candidate.payload, candidate.phase) === 'final');

  useEffect(() => {
    if (confirmed) clearRuiDraft(requestId);
  }, [confirmed, requestId]);

  /** 只有明确接收成功才结束本次提交；失败交给表单保留草稿。 */
  async function respond(_requestId: string, response: Record<string, unknown>): Promise<void> {
    if (!props.onAnswer) return;
    setError(null);
    try {
      await props.onAnswer(item, response.answers as AsyncQuestionAnswer['answers'], closed);
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : null;
      if (code === 'ZEUS_ASYNC_QUESTION_TURN_ENDED' || code === 'ZEUS_NATIVE_TURN_MISMATCH') setRejectedTurn(true);
      setError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    }
  }

  return (
    <section id={asyncQuestionAnchor(item)} className="session-async-question" aria-label={zh ? '中途问题' : 'Mid-turn question'}>
      <ThreadItemView item={item} language={language} />
      <div className="session-message-delivery-actions">
        <span role="status">
          {confirmed
            ? zh
              ? '回答已送达'
              : 'Answer delivered'
            : pending
              ? pendingLabel
              : closed
                ? zh
                  ? '原轮次已结束，回答可作为新消息发送'
                  : 'Original turn ended. Send your answer as a new message.'
                : zh
                  ? '有问题待回答'
                  : 'Answer requested'}
        </span>
        {!confirmed && !pending && props.onAnswer ? (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? (zh ? '收起问题' : 'Hide question') : zh ? '回答问题' : 'Answer question'}
          </button>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {expanded && !confirmed && !pending && props.onAnswer ? (
        <RequestUserInputPanel
          request={{ id: requestId, expiresAt: null }}
          questions={questions}
          language={language}
          autoFocus={false}
          answerAttachmentsSupported={false}
          confirmSelection
          retainDraft
          submitLabel={closed ? (zh ? '作为新消息发送' : 'Send as new message') : zh ? '提交回答' : 'Submit answer'}
          onDismiss={() => setExpanded(false)}
          onRespond={respond}
        />
      ) : null}
    </section>
  );
}
