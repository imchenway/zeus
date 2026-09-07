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

/** 答案草稿和底部选择共用原会话、轮次与问题身份，不依赖时间线行键。 */
export function asyncQuestionIdentity(item: NativeSessionItemBuffer): string {
    return `${item.conversationId}/${item.turnId}/${item.providerItemId ?? item.itemId}`;
}

/** 问题记录和底部表单使用相同的送达与轮次终态事实。 */
function asyncQuestionStatus(item: NativeSessionItemBuffer, state: NativeSessionState) {
    /** 实时答复与分页恢复的答复账本共同提供送达证据。 */
  const reply = asyncQuestionReply(item, state);
    /** 历史分页不要求同时载入对应的用户答复消息。 */
  const response = item.payload.questionResponse as AsyncQuestionResponse | undefined;
    /** 明确送达后才清理问题草稿。 */
  const confirmed = Boolean((reply && !reply.optimistic && reply.providerItemId && reply.status === 'completed') || response?.status === 'resolved' || response?.status === 'completed');
    /** 已失败或取消的答复不能使原问题永久失去重试入口。 */
  const deliveryStatus = response?.status ?? reply?.status;
    /** 已接收但未确认的答案不能重复提交。 */
    const pending = Boolean((reply || response) && !confirmed && !['failed', 'cancelled', 'deleted'].includes(deliveryStatus ?? ''));
    /** 正式终态与最终交付决定是否需要明确另发消息。 */
    const closed =
        Boolean(state.terminalTurnIds[item.turnId] || state.turnsByProviderId[item.turnId]?.completedAt) ||
        Object.values(state.items).some((candidate) => candidate.turnId === item.turnId && itemRole(candidate) === 'assistant' && candidate.status === 'completed' && classifyAssistantMessage(candidate.payload, candidate.phase) === 'final');
    return {confirmed, pending, deliveryStatus, closed};
}

/** 当前窗口内保留问题选择和稍后回答状态；重启后重新提醒未回答问题。 */
interface AsyncQuestionDockSelection {
    /** 正在填写的问题不会被后续提问或轮次结束替换。 */
    selectedId: string | null;
    /** 本窗口已接到的问题继续排队，不因原轮次结束丢掉后续题目。 */
    offered: Set<string>;
    /** 收起只影响本窗口展示，不改变 Provider 问题状态。 */
    dismissed: Set<string>;
}

/** 按产品会话隔离底部状态，切换会话时不串用草稿或展开选择。 */
const asyncQuestionDockSelections = new Map<string, AsyncQuestionDockSelection>();

/** 在底部依次处理异步问题；无需把异步交付伪装成阻塞请求。 */
export function useAsyncQuestionDock(state: NativeSessionState | null, enabled: boolean) {
    /** 会话身份变化时读取该会话已保存的界面状态。 */
    const conversationId = state?.conversationId ?? '';
    /** 选择变化只重画当前工作区，流式消息仍由原有投影负责。 */
    const [, refresh] = useState(0);
    /** 记忆只存界面选择，不存问题正文或答案。 */
    const selection = useMemo(() => {
        /** 已访问会话复用同一份收起状态。 */
        const saved = asyncQuestionDockSelections.get(conversationId);
        if (saved) return saved;
        /** 首次打开时按到达顺序自动选择当前轮次的问题。 */
        const created: AsyncQuestionDockSelection = {selectedId: null, offered: new Set(), dismissed: new Set()};
        if (conversationId) asyncQuestionDockSelections.set(conversationId, created);
        return created;
    }, [conversationId]);
    /** 完整问题按稳定时间排序；活动表单不依赖消息虚拟列表是否挂载。 */
    const questions = state
        ? Object.values(state.items)
            .filter((item) => item.status === 'completed' && itemRole(item) === 'assistant' && classifyAssistantMessage(item.payload, item.phase) === 'question' && !asyncQuestionStatus(item, state).confirmed)
            .sort((left, right) => (left.timelineAt ?? left.updatedAt ?? '').localeCompare(right.timelineAt ?? right.updatedAt ?? '') || left.key.localeCompare(right.key))
        : [];
    /** 先保留当前题，再处理本窗口接到的队列；旧历史题仍由用户主动打开。 */
    const selected =
        enabled && state
            ? (questions.find((item) => asyncQuestionIdentity(item) === selection.selectedId) ??
                questions.find(
                    (item) =>
                        (selection.offered.has(asyncQuestionIdentity(item)) || (item.turnId === state.activeTurnId && !asyncQuestionStatus(item, state).closed)) &&
                        !selection.dismissed.has(asyncQuestionIdentity(item)) &&
                        !asyncQuestionStatus(item, state).pending,
                ) ??
                null)
            : null;
    /** 固定自动选择的身份，避免轮次结束或新增问题抢走表单。 */
    const selectedId = selected ? asyncQuestionIdentity(selected) : null;
    useEffect(() => {
        if (!enabled) return;
        selection.selectedId = selectedId;
        for (const item of questions) {
            if (item.turnId === state?.activeTurnId) selection.offered.add(asyncQuestionIdentity(item));
        }
    }, [enabled, questions, selectedId, selection, state?.activeTurnId]);

    /** 所有待回答入口只改变底部选择，不滚动到历史里的选项表单。 */
    function open(item: NativeSessionItemBuffer): void {
        selection.selectedId = asyncQuestionIdentity(item);
        selection.dismissed.delete(selection.selectedId);
        refresh((revision) => revision + 1);
    }

    /** 手动收起或提交被接收后继续下一题；失败不会走到此处。 */
    function dismiss(item: NativeSessionItemBuffer): void {
        selection.dismissed.add(asyncQuestionIdentity(item));
        selection.selectedId = null;
        refresh((revision) => revision + 1);
    }

    return {
        selected,
        questions: questions.filter(
            (item) =>
                state &&
                !asyncQuestionStatus(item, state).pending &&
                (item.turnId === state.activeTurnId || selection.offered.has(asyncQuestionIdentity(item)) || selection.dismissed.has(asyncQuestionIdentity(item)) || asyncQuestionIdentity(item) === selectedId),
        ),
        open,
        dismiss,
    };
}

/** 时间线只记录问题摘要与送达状态，可操作的答案表单归底部工作区所有。 */
export function AsyncQuestionMessage(props: {
    item: NativeSessionItemBuffer;
    state: NativeSessionState;
    language: SessionUiLanguage;
    onOpen?: (item: NativeSessionItemBuffer) => void
}) {
    /** 沿用原问题及当前会话的真实状态。 */
    const {item, state, language} = props;
    /** 当前界面语言。 */
    const zh = language === 'zh-CN';
    /** 实时与恢复状态统一解释。 */
    const {confirmed, pending, deliveryStatus, closed} = asyncQuestionStatus(item, state);
    /** 接收、排队和未知送达分别显示，不把接收当作已回答。 */
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
    /** 与原表单一致的草稿键，迁移展示位置不丢弃已填写答案。 */
    const requestId = asyncQuestionIdentity(item);

  useEffect(() => {
    if (confirmed) clearRuiDraft(requestId);
  }, [confirmed, requestId]);

  return (
      <section className="session-async-question" aria-label={zh ? '中途问题' : 'Mid-turn question'}>
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
          {!confirmed && !pending && props.onOpen ? (
              <button type="button" onClick={() => props.onOpen?.(item)}>
                  {zh ? '回答问题' : 'Answer question'}
          </button>
        ) : null}
      </div>
      </section>
  );
}

/** 底部复用同步询问表单；答案仍通过原异步问题的引导通道发送。 */
export function AsyncQuestionPanel(props: {
    item: NativeSessionItemBuffer;
    state: NativeSessionState;
    language: SessionUiLanguage;
    onAnswer: (item: NativeSessionItemBuffer, answers: AsyncQuestionAnswer['answers'], asNewMessage: boolean) => Promise<void>;
    onDismiss: () => void;
}) {
    /** 当前问题与语言。 */
    const {item, state, language} = props;
    /** 复用原规范化与稳定草稿键，收起或换题时可恢复答案。 */
    const questions = useMemo(() => normalizeRequestQuestions({payload: {questions: asyncMessageQuestions(item.payload)}}), [item.payload]);
    /** 服务端拒绝旧轮次后保留表单，让用户明确选择另发消息。 */
    const [rejectedTurn, setRejectedTurn] = useState(false);
    /** 已接收的答案不能重复点击；正在提交时保持同一个表单实例。 */
    const status = asyncQuestionStatus(item, state);
    /** 当前表单是否需要明确的新消息动作。 */
    const closed = rejectedTurn || status.closed;
    /** 当前界面语言。 */
    const zh = language === 'zh-CN';

    /** 接收成功才释放底部；失败由共用表单保留草稿并显示错误弹窗。 */
    async function respond(_requestId: string, response: Record<string, unknown>): Promise<void> {
        try {
            await props.onAnswer(item, response.answers as AsyncQuestionAnswer['answers'], closed);
            props.onDismiss();
        } catch (failure) {
            /** 只认可已存在的明确轮次拒绝码，不推测是否需要另发。 */
            const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : null;
            if (code === 'ZEUS_ASYNC_QUESTION_TURN_ENDED' || code === 'ZEUS_NATIVE_TURN_MISMATCH') setRejectedTurn(true);
            throw failure;
        }
    }

    return (
        <RequestUserInputPanel
            request={{id: asyncQuestionIdentity(item), expiresAt: null}}
            questions={questions}
            language={language}
            autoFocus
            busy={status.pending}
            answerAttachmentsSupported={false}
            confirmSelection
            retainDraft
            submitLabel={closed ? (zh ? '作为新消息发送' : 'Send as new message') : zh ? '提交回答' : 'Submit answer'}
            onDismiss={props.onDismiss}
            onRespond={respond}
        />
  );
}
