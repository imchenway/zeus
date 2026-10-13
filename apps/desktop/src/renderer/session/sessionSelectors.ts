import { classifyAssistantMessage } from '@zeus/shared';
import type { NativeSessionItemBuffer, NativeSessionState } from './sessionTypes.js';

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
  return item.optimistic === true && ['user', 'usermessage'].includes(type) && ['pending', 'queued', 'dispatching', 'active'].includes(item.status);
}

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
