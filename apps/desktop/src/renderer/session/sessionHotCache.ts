import type { NativeSessionState } from './sessionTypes.js';

export const ordinarySessionHotCacheLimit = 10;

export interface SessionHotCacheEntry {
  state: NativeSessionState;
}

export type SessionHotCache = Map<string, SessionHotCacheEntry>;

/** 关键会话不参与普通最近使用数量淘汰，确保活动现场可立即恢复。 */
export function isCriticalSessionState(state: NativeSessionState): boolean {
  if (state.pendingRequests.some((request) => request.status === 'pending')) return true;
  if (state.planImplementationRequests.some((request) => request.status === 'pending')) return true;
  if (state.queue && (state.queue.state.type !== 'idle' || state.queue.submissions.some((submission) => submission.status === 'queued' || submission.status === 'paused'))) return true;
  return ['starting_turn', 'active_prework', 'active_final_answer', 'waiting_approval', 'waiting_user_input', 'interrupt_confirm', 'interrupting'].includes(state.conversationState);
}

/** 只缓存已经成功取得权威快照的会话；Map 顺序同时表达普通会话的最近使用顺序。 */
export function rememberSessionHotState(cache: SessionHotCache, conversationId: string, state: NativeSessionState, ordinaryLimit = ordinarySessionHotCacheLimit): void {
  if (!state.snapshot || state.conversationId !== conversationId || state.snapshot.id !== conversationId) return;
  cache.delete(conversationId);
  cache.set(conversationId, { state });

  let ordinaryCount = 0;
  for (const entry of cache.values()) {
    if (!isCriticalSessionState(entry.state)) ordinaryCount += 1;
  }
  if (ordinaryCount <= ordinaryLimit) return;

  for (const [cachedConversationId, entry] of cache) {
    if (ordinaryCount <= ordinaryLimit) break;
    if (isCriticalSessionState(entry.state)) continue;
    cache.delete(cachedConversationId);
    ordinaryCount -= 1;
  }
}
