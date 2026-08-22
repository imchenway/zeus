import type { NativeSessionState } from './sessionTypes.js';

export const ordinarySessionHotCacheLimit = 6;
export const sessionHotCacheByteLimit = 32 * 1024 * 1024;
export const sessionHotCacheEntryByteLimit = 8 * 1024 * 1024;

export interface SessionHotCacheEntry {
  state: NativeSessionState;
  estimatedBytes: number;
}

export type SessionHotCache = Map<string, SessionHotCacheEntry>;

/** 关键会话不参与普通最近使用数量淘汰，确保活动现场可立即恢复。 */
export function isCriticalSessionState(state: NativeSessionState): boolean {
  if (state.pendingRequests.some((request) => request.status === 'pending')) return true;
  if (state.planImplementationRequests.some((request) => request.status === 'pending')) return true;
  if (state.queue && (state.queue.state.type !== 'idle' || state.queue.submissions.some((submission) => submission.status === 'queued' || submission.status === 'paused'))) return true;
  return ['starting_turn', 'active_prework', 'active_final_answer', 'waiting_approval', 'waiting_user_input', 'interrupt_confirm', 'interrupting'].includes(state.conversationState);
}

/**
 * 只缓存已经成功取得权威快照且体积受控的会话。
 *
 * JSON 字符数按 UTF-16 上界折算为字节；估算只在会话离开热路径时执行，不参与流式增量。
 * Map 顺序表达最近使用顺序，先淘汰普通会话，再淘汰最旧关键会话；缓存永远不是业务事实。
 */
export function rememberSessionHotState(cache: SessionHotCache, conversationId: string, state: NativeSessionState, options: { ordinaryLimit?: number; totalByteLimit?: number; entryByteLimit?: number } = {}): void {
  if (!state.snapshot || state.conversationId !== conversationId || state.snapshot.id !== conversationId) return;
  const estimatedBytes = estimateSessionHotStateBytes(state);
  const entryByteLimit = options.entryByteLimit ?? sessionHotCacheEntryByteLimit;
  cache.delete(conversationId);
  if (!Number.isFinite(estimatedBytes) || estimatedBytes > entryByteLimit) return;
  cache.set(conversationId, { state, estimatedBytes });

  const ordinaryLimit = options.ordinaryLimit ?? ordinarySessionHotCacheLimit;
  let ordinaryCount = 0;
  for (const entry of cache.values()) {
    if (!isCriticalSessionState(entry.state)) ordinaryCount += 1;
  }
  if (ordinaryCount > ordinaryLimit) {
    for (const [cachedConversationId, entry] of cache) {
      if (ordinaryCount <= ordinaryLimit) break;
      if (isCriticalSessionState(entry.state)) continue;
      cache.delete(cachedConversationId);
      ordinaryCount -= 1;
    }
  }

  // 会话数已经达标也必须继续执行总字节预算；否则 6 个接近 8 MiB 的条目可越过 32 MiB 上限。
  const totalByteLimit = options.totalByteLimit ?? sessionHotCacheByteLimit;
  evictUntilWithinByteBudget(cache, totalByteLimit, false);
  evictUntilWithinByteBudget(cache, totalByteLimit, true);
}

function estimateSessionHotStateBytes(state: NativeSessionState): number {
  try {
    return JSON.stringify(state).length * 2;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function evictUntilWithinByteBudget(cache: SessionHotCache, byteLimit: number, includeCritical: boolean): void {
  let totalBytes = 0;
  for (const entry of cache.values()) totalBytes += entry.estimatedBytes;
  if (totalBytes <= byteLimit) return;
  for (const [conversationId, entry] of cache) {
    if (totalBytes <= byteLimit) break;
    if (!includeCritical && isCriticalSessionState(entry.state)) continue;
    cache.delete(conversationId);
    totalBytes -= entry.estimatedBytes;
  }
}
