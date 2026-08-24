import { emptyConversationContextDraft } from '@zeus/shared';
import type { NativeSessionState } from './sessionTypes.js';

export const ordinarySessionHotCacheLimit = 6;
export const sessionHotCacheByteLimit = 32 * 1024 * 1024;
export const sessionHotCacheEntryByteLimit = 8 * 1024 * 1024;
export const sessionViewCacheMaximumEntries = 32;
export const sessionViewCacheSchemaGeneration = 'zeus-session-view-cache-v1';
export const sessionViewCacheMaximumAgeMs = 14 * 24 * 60 * 60 * 1000;

export interface SessionHotCacheEntry {
  state: NativeSessionState;
  estimatedBytes: number;
  cachedAt: number;
}

export type SessionHotCache = Map<string, SessionHotCacheEntry>;

export interface PersistedSessionViewCache {
  schemaGeneration: typeof sessionViewCacheSchemaGeneration;
  savedAt: string;
  entries: Array<{
    conversationId: string;
    projectId: string;
    cachedAt: string;
    state: NativeSessionState;
  }>;
}

let primedSessionHotCache: SessionHotCache = new Map();

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
 * JSON 字符数按 UTF-16 上界估算内存体积；估算只在会话离开热路径时执行，不参与流式增量。
 * Map 顺序表达最近使用顺序，先淘汰普通会话，再淘汰最旧关键会话；缓存永远不是业务事实。
 */
export function rememberSessionHotState(cache: SessionHotCache, conversationId: string, state: NativeSessionState, options: { ordinaryLimit?: number; totalByteLimit?: number; entryByteLimit?: number; cachedAt?: number } = {}): boolean {
  if (!state.snapshot || state.conversationId !== conversationId || state.snapshot.id !== conversationId) return false;
  const estimatedBytes = estimateSessionHotStateBytes(state);
  const entryByteLimit = options.entryByteLimit ?? sessionHotCacheEntryByteLimit;
  cache.delete(conversationId);
  if (!Number.isFinite(estimatedBytes) || estimatedBytes > entryByteLimit) return false;
  cache.set(conversationId, { state, estimatedBytes, cachedAt: options.cachedAt ?? Date.now() });

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
  return cache.has(conversationId);
}

function estimateSessionHotStateBytes(state: NativeSessionState): number {
  try {
    return JSON.stringify(state).length * 2;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 将进程内热缓存转成可跨重启使用的纯显示副本。
 *
 * 草稿、附件、待审批表单、发送队列和瞬时错误均由各自权威存储恢复，不能从旧显示缓存复活。
 */
export function buildPersistedSessionViewCache(cache: SessionHotCache, now = Date.now()): PersistedSessionViewCache {
  const entries: PersistedSessionViewCache['entries'] = [];
  let remainingBytes = sessionHotCacheByteLimit;
  const candidates = [...cache.entries()].slice(-sessionViewCacheMaximumEntries).reverse();
  for (const [conversationId, entry] of candidates) {
    const state = sanitizeSessionStateForPersistence(entry.state);
    if (!state?.projectId || !state.snapshot || state.snapshot.projectId !== state.projectId || state.snapshot.id !== conversationId) continue;
    const persistedBytes = estimatePersistedSessionStateBytes(state);
    if (!Number.isFinite(persistedBytes) || persistedBytes > sessionHotCacheEntryByteLimit || persistedBytes > remainingBytes) continue;
    remainingBytes -= persistedBytes;
    entries.unshift({
      conversationId,
      projectId: state.projectId,
      cachedAt: new Date(entry.cachedAt).toISOString(),
      state,
    });
  }
  return {
    schemaGeneration: sessionViewCacheSchemaGeneration,
    savedAt: new Date(now).toISOString(),
    entries,
  };
}

function estimatePersistedSessionStateBytes(state: NativeSessionState): number {
  try {
    return new TextEncoder().encode(JSON.stringify(state)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Main 在 React 首次渲染前调用；损坏、过期或越界内容只会被忽略。 */
export function primePersistedSessionViewCache(value: unknown, now = Date.now()): void {
  primedSessionHotCache = restorePersistedSessionViewCache(value, now);
}

/** 每个 Workspace 取得独立 Map，避免模块级启动副本被运行期淘汰逻辑直接修改。 */
export function initialSessionHotCache(): SessionHotCache {
  return new Map(primedSessionHotCache);
}

function restorePersistedSessionViewCache(value: unknown, now: number): SessionHotCache {
  const restored: SessionHotCache = new Map();
  if (!isRecord(value) || value.schemaGeneration !== sessionViewCacheSchemaGeneration || !Array.isArray(value.entries)) return restored;
  const savedAt = timestamp(value.savedAt);
  if (savedAt === null || savedAt > now + 60_000 || now - savedAt > sessionViewCacheMaximumAgeMs) return restored;
  const entries = value.entries
    .flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.conversationId !== 'string' || typeof entry.projectId !== 'string' || !isRecord(entry.state)) return [];
      const cachedAt = timestamp(entry.cachedAt);
      if (cachedAt === null || cachedAt > now + 60_000 || now - cachedAt > sessionViewCacheMaximumAgeMs) return [];
      const state = sanitizeSessionStateForPersistence(entry.state as unknown as NativeSessionState);
      if (!state || state.projectId !== entry.projectId || state.conversationId !== entry.conversationId || state.snapshot?.projectId !== entry.projectId || state.snapshot.id !== entry.conversationId) return [];
      return [{ conversationId: entry.conversationId, cachedAt, state }];
    })
    .sort((left, right) => left.cachedAt - right.cachedAt);
  for (const entry of entries) rememberSessionHotState(restored, entry.conversationId, entry.state, { cachedAt: entry.cachedAt });
  return restored;
}

function sanitizeSessionStateForPersistence(state: NativeSessionState): NativeSessionState | null {
  if (!isRecord(state) || typeof state.conversationId !== 'string' || typeof state.projectId !== 'string' || !isRecord(state.snapshot)) return null;
  try {
    const authoritativeItemOrder = state.itemOrder.filter((key) => state.items[key] && !state.items[key].optimistic);
    const authoritativeItems = Object.fromEntries(authoritativeItemOrder.map((key) => [key, state.items[key]]));
    const emptyQueue = { state: { type: 'idle' as const }, submissions: [] };
    return {
      ...state,
      transportState: 'disconnected',
      reconnectAttempt: 0,
      snapshot: {
        ...state.snapshot,
        pendingRequestKind: null,
        executionQueue: emptyQueue,
        submissions: [],
        queue: emptyQueue,
        requests: [],
        planImplementationRequests: [],
      },
      items: authoritativeItems,
      itemOrder: authoritativeItemOrder,
      queue: null,
      pendingRequests: [],
      planImplementationRequests: [],
      draft: '',
      attachments: [],
      browserSubmission: null,
      contextDraft: structuredClone(emptyConversationContextDraft),
      busyOperation: null,
      error: null,
    };
  } catch {
    return null;
  }
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
