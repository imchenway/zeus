import type { NativeSessionState } from './sessionTypes.js';

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
