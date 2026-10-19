import { emptyConversationContextDraft } from '@zeus/shared';
import type { NativeSessionState } from './sessionTypes.js';
import { resumeCachedConversationSnapshot } from './conversationSnapshotV2Adapter.js';
import { retainResourcesOwnedByItem } from './conversationResourceProjection.js';

/** 普通会话热缓存的最大数量。 */
export const ordinarySessionHotCacheLimit = 12;
/** 全部热缓存的估算字节上限。 */
export const sessionHotCacheByteLimit = 32 * 1024 * 1024;
/** 单个会话热缓存的估算字节上限。 */
export const sessionHotCacheEntryByteLimit = 8 * 1024 * 1024;
/** 磁盘显示缓存允许保留的最大会话数。 */
export const sessionViewCacheMaximumEntries = 32;
/** 磁盘显示缓存的结构代次。 */
export const sessionViewCacheSchemaGeneration = 'zeus-session-display-cache';
/** 磁盘显示缓存的最长保留时间。 */
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
 * JSON 字符数按 UTF-16 上界估算内存体积；估算只在恢复或空闲持久化边界执行，不参与流式增量。
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

/** 流式更新只替换最新引用；缓存未命中也延后到空闲边界测量，避免超限会话逐事件序列化。 */
export function refreshSessionHotState(cache: SessionHotCache, conversationId: string, state: NativeSessionState): boolean {
  if (!state.snapshot || state.conversationId !== conversationId || state.snapshot.id !== conversationId) return false;
  /** 已有估算用于流式期间的临时预算；零值表示尚未在稳定边界测量。 */
  const previous = cache.get(conversationId);
  cache.delete(conversationId);
  cache.set(conversationId, { state, estimatedBytes: previous?.estimatedBytes ?? 0, cachedAt: Date.now() });
  return true;
}

/** 仅在稳定边界估算进程内状态的 UTF-16 上界。 */
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

/** 估算清洗后磁盘显示副本的 UTF-8 字节数。 */
function estimatePersistedSessionStateBytes(state: NativeSessionState): number {
  try {
    return new TextEncoder().encode(JSON.stringify(state)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** 窗口只持有已访问会话的热缓存，磁盘按选择身份异步读取。 */
export function initialSessionHotCache(): SessionHotCache {
  return new Map();
}

/** 复用显示态清洗与有效期检查，拒绝跨项目缓存。 */
export function restoreSessionViewCache(value: unknown, identity: { projectId: string; conversationId: string }): NativeSessionState | undefined {
  const state = restorePersistedSessionViewCache(value, Date.now()).get(identity.conversationId)?.state;
  return state?.projectId === identity.projectId ? state : undefined;
}

/** 信封校验与显示态恢复共用内存缓存的体积边界。 */
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

/** 显示缓存读写共用校验；重复持久身份由权威加载恢复，不进入首帧渲染。 */
function sanitizeSessionStateForPersistence(state: NativeSessionState): NativeSessionState | null {
  if (!isRecord(state) || typeof state.conversationId !== 'string' || typeof state.projectId !== 'string' || !isRecord(state.snapshot)) return null;
  try {
    const authoritativeItemOrder = state.itemOrder.filter((key) => state.items[key] && !state.items[key].optimistic);
    /** 旧窗口留下的重复正文不能随缓存恢复再次触发界面错误。 */
    const transcriptEntryIds = authoritativeItemOrder.flatMap((key) => (state.items[key]!.transcript ? [state.items[key]!.transcript!.placement.entryId] : []));
    if (new Set(transcriptEntryIds).size !== transcriptEntryIds.length) return null;
    /** 缓存首帧也遵守资源归属，不能等联网后才移除串到其他消息的图片。 */
    const resourceMetadataById = new Map((state.snapshot.v2Paging?.resources.items ?? []).map((resource) => [resource.id, resource]));
    /** 用户消息只恢复属于自己的附件，保留其他条目的现有资源行为。 */
    const authoritativeItems = Object.fromEntries(
      authoritativeItemOrder.map((key) => {
        /** 只清理用户消息；助手合成交付项仍代表原工具的资源。 */
        const item = state.items[key]!;
        if (!['usermessage', 'user'].includes(item.type.toLowerCase().replace(/[\s_\-/]+/gu, ''))) return [key, item];
        return [key, { ...item, resources: retainResourcesOwnedByItem(item.resources, item.localItemId ?? item.itemId, item.transcript?.placement.entryId, resourceMetadataById) }];
      }),
    );
    const emptyQueue = { throughEventSeq: 0, state: { type: 'idle' as const }, submissions: [] };
    const resumedSnapshot = resumeCachedConversationSnapshot(state.snapshot);
    return {
      ...state,
      transportState: 'disconnected',
      reconnectAttempt: 0,
      snapshot: {
        ...resumedSnapshot,
        /** 同时清理快照副本，避免后续状态合并再次带回错误关联。 */
        items: resumedSnapshot.items.map((item) =>
          ['usermessage', 'user'].includes(item.type.toLowerCase().replace(/[\s_\-/]+/gu, ''))
            ? { ...item, resources: retainResourcesOwnedByItem(item.resources ?? [], item.id, item.transcript.placement.entryId, resourceMetadataById) }
            : item,
        ),
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

/** 将缓存时间解析为可比较的毫秒值。 */
function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 判断持久化输入是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 按最近使用顺序淘汰普通或关键会话，直到总预算恢复。 */
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
