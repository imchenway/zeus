import { classifyAssistantMessage } from '@zeus/shared';
import type { NativeSessionItemBuffer, NativeSessionState } from './sessionTypes.js';
import { isSubmissionWaitingInQueue } from './conversationQueuePresentation.js';

/** 自动建议只接受已经完整交付的助手正文，过程、问题和工具输出不算回复。 */
export function isInputSuggestionReply(item: NativeSessionItemBuffer): boolean {
  /** 各 Provider 的正文类型沿用现有会话显示语义。 */
  const type = item.type.toLowerCase().replaceAll(/[^a-z]/gu, '');
  return item.status === 'completed' && Boolean(item.text.trim()) && ['agentmessage', 'assistantmessage', 'assistant', 'message'].includes(type) && classifyAssistantMessage(item.payload, item.phase) === 'final';
}

/** 尚未移交到权威队列的本地提交也必须立即阻止旧建议。 */
export function isInputSuggestionPendingMessage(item: NativeSessionItemBuffer): boolean {
  /** 乐观消息始终属于用户输入，不能用它充当模型正文。 */
  const type = item.type.toLowerCase().replaceAll(/[^a-z]/gu, '');
  return (
    item.optimistic === true &&
    ['user', 'usermessage'].includes(type) &&
    (['pending', 'accepted', 'queued', 'dispatching', 'active'].includes(item.status) || (item.status === 'unconfirmed' && Number(item.payload.deliveryReconnectAttempt) > 0))
  );
}

/** 尚未获得轮次的发送也提供即时反馈；已结束、排队及原题回答不占用当前执行提示。 */
export function selectPendingExecutionMessage(state: NativeSessionState): NativeSessionItemBuffer | undefined {
  return Object.values(state.items)
    .reverse()
    .find((item) => {
      if (!isInputSuggestionPendingMessage(item) || item.providerItemId || state.terminalTurnIds[item.turnId] || item.payload.questionAnswer) return false;
      /** 权威队列到达后按实际等待关系接管，不能继续使用本地发送假设。 */
      const submission = state.queue?.submissions.find((candidate) => candidate.id === item.payload.submissionId || Boolean(candidate.clientUserMessageId && candidate.clientUserMessageId === item.clientUserMessageId));
      return !isSubmissionWaitingInQueue(state, submission ?? null);
    });
}

/** 按稳定客户端身份判断持久用户正文是否已经接管本地显示记录。 */
export function selectHasConfirmedUserMessage(state: NativeSessionState, clientUserMessageId: string): boolean {
  if (!clientUserMessageId) return false;
  return state.itemOrder.some((key) => {
    const item = state.items[key];
    if (!item || item.optimistic) return false;
    const itemType = item.type.toLowerCase();
    const userItem = itemType === 'user' || itemType === 'usermessage' || itemType === 'user_message';
    return userItem && (item.clientUserMessageId === clientUserMessageId || item.durableClientUserMessageId === clientUserMessageId);
  });
}
