import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { type ConversationContextDraft, emptyConversationContextDraft, hasConversationContext, serializeConversationContext, type ZeusBrowserPreparedSubmission } from '@zeus/shared';
import { createInitialSessionState, sessionReducer } from './sessionReducer.js';
import {
  type CodexConversationCapabilities,
  type ConversationResourcePreview,
  isNativeConversationEvent,
  type NativeCollaborationMode,
  type NativeConversationAttachment,
  type NativeConversationChangeFileV2Item,
  type NativeConversationChangeSetV2Summary,
  type NativeConversationChoice,
  type NativeConversationContentV2Page,
  type NativeConversationEvent,
  type NativeConversationEventPage,
  type NativeConversationModelHistoryV2Item,
  type NativeConversationProcessV2Item,
  type NativeConversationResourceV2Item,
  type NativeConversationSnapshot,
  type NativeConversationSnapshotV2,
  type NativeConversationSnapshotV2Page,
  type NativeConversationToolResultPage,
  type NativeGoalResponse,
  type NativeNextTurnSettings,
  type NativeOperationAcceptance,
  type NativePendingRequest,
  type NativePermissionMode,
  type NativePlanImplementationRequest,
  type NativeQueuedSubmission,
  type NativeQueueSnapshot,
  type NativeRealtimeEventEnvelope,
  type NativeSessionError,
  type NativeSessionState,
  type NativeSubagentListSnapshot,
  type NativeSubagentThreadSnapshot,
  type NativeTurnSettingsSelection,
  type SendNativeMessageRequest,
  type TurnChangeSet,
  type TurnChangeSetOperationResult,
} from './sessionTypes.js';
import { adaptConversationSnapshotV2, mergeConversationHistoryV2, mergeConversationProcessV2, updateConversationV2Paging } from './conversationSnapshotV2Adapter.js';
import { markConversationNavigationRenderReady } from '../performanceTraceContext.js';

export const reconnectBackoffMs = [250, 500, 1_000, 2_000, 5_000] as const;
// 同一个会话项的增量按一帧窗口合并，兼顾 Markdown 成本与首字可见延迟。
const RENDER_DELTA_COALESCE_MS = 16;
const CONVERSATION_SCHEMA_GENERATION = '2026-08-16-unified-conversation-segments' as const;
const CONVERSATION_SYNC_STREAM_GENERATION = 'zeus-conversation-sync-v1' as const;

export const sessionRealtimeBufferBudget = Object.freeze({
  maxEntries: 2_048,
  maxBytes: 8 * 1024 * 1024,
});

type RealtimeBufferKind = 'hydration' | 'targeted-hydration' | 'sync-gap' | 'render-delta';

interface BufferedRealtimeEvents {
  readonly kind: RealtimeBufferKind;
  readonly events: NativeRealtimeEventEnvelope[];
  bytes: number;
  overflowed: boolean;
}

export function reconnectDelayMs(attempt: number): number {
  return reconnectBackoffMs[Math.min(Math.max(0, Math.floor(attempt) - 1), reconnectBackoffMs.length - 1)]!;
}

/**
 * 返回可保守用于硬预算的 JSON 传输字节上界。字符串按每个 UTF-16 code unit
 * 最多 3 个 UTF-8 字节计，不复制可能很大的累计流式正文。
 */
export function estimateNativeRealtimeEventBytes(event: NativeRealtimeEventEnvelope): number {
  return estimateJsonBytes(event, new WeakSet<object>(), sessionRealtimeBufferBudget.maxBytes + 1);
}

function estimateJsonBytes(value: unknown, seen: WeakSet<object>, stopAfter: number): number {
  if (value === null) return 4;
  if (typeof value === 'string') return 2 + value.length * 3;
  if (typeof value === 'number') return 24;
  if (typeof value === 'boolean') return 5;
  if (typeof value !== 'object') return 4;
  if (seen.has(value)) return stopAfter;
  seen.add(value);
  let bytes = 2;
  if (Array.isArray(value)) {
    for (const entry of value) {
      bytes += 1 + estimateJsonBytes(entry, seen, stopAfter - bytes);
      if (bytes >= stopAfter) return stopAfter;
    }
    return bytes;
  }
  for (const [key, entry] of Object.entries(value)) {
    bytes += 4 + key.length * 3 + estimateJsonBytes(entry, seen, stopAfter - bytes);
    if (bytes >= stopAfter) return stopAfter;
  }
  return bytes;
}

function createRealtimeEventBuffer(kind: BufferedRealtimeEvents['kind']): BufferedRealtimeEvents {
  return { kind, events: [], bytes: 0, overflowed: false };
}

function appendRealtimeEvent(buffer: BufferedRealtimeEvents, event: NativeRealtimeEventEnvelope): boolean {
  if (buffer.overflowed) return false;
  const bytes = estimateNativeRealtimeEventBytes(event);
  if (buffer.events.length >= sessionRealtimeBufferBudget.maxEntries || bytes > sessionRealtimeBufferBudget.maxBytes - buffer.bytes) {
    buffer.overflowed = true;
    return false;
  }
  buffer.events.push(event);
  buffer.bytes += bytes;
  return true;
}

function realtimeBufferBudgetError(kind: RealtimeBufferKind): Error {
  const error = new Error(`会话 ${kind} 缓冲已达到 ${sessionRealtimeBufferBudget.maxEntries} 条或 ${sessionRealtimeBufferBudget.maxBytes} 字节硬上限；已停止增量投影并回到权威 Snapshot V2。`);
  error.name = 'ZeusRealtimeBufferBudgetExceededError';
  return error;
}

export interface SessionControllerClient {
  loadCodexConversationCapabilities?(projectId: string): Promise<CodexConversationCapabilities>;
  loadNativeConversationV2(projectId: string, conversationId: string): Promise<NativeConversationSnapshotV2>;
  loadNativeConversationChoice(projectId: string, conversationId: string): Promise<NativeConversationChoice>;
  loadNativeConversationQueueV2(projectId: string, conversationId: string): Promise<NativeQueueSnapshot>;
  loadNativeConversationModelHistoryV2(
    projectId: string,
    conversationId: string,
    options?: { cursor?: string; limit?: number; byteLimit?: number; direction?: 'forward' | 'tail' },
  ): Promise<NativeConversationSnapshotV2Page<NativeConversationModelHistoryV2Item>>;
  loadNativeConversationProcessV2?(
    projectId: string,
    conversationId: string,
    turnId: string,
    options?: { cursor?: string; limit?: number; byteLimit?: number; kind?: NativeConversationProcessV2Item['kind'] },
  ): Promise<NativeConversationSnapshotV2Page<NativeConversationProcessV2Item>>;
  loadNativeConversationResourcesV2?(projectId: string, conversationId: string, options?: { cursor?: string; limit?: number; byteLimit?: number }): Promise<NativeConversationSnapshotV2Page<NativeConversationResourceV2Item>>;
  loadNativeConversationChangeSetV2?(projectId: string, conversationId: string, turnId: string): Promise<NativeConversationChangeSetV2Summary>;
  loadNativeConversationChangeFilesV2?(
    projectId: string,
    conversationId: string,
    turnId: string,
    changeSetId: string,
    options?: { cursor?: string; limit?: number; byteLimit?: number },
  ): Promise<NativeConversationSnapshotV2Page<NativeConversationChangeFileV2Item>>;
  loadNativeConversationContentV2?(projectId: string, conversationId: string, handle: string, options?: { offset?: number; byteLimit?: number }): Promise<NativeConversationContentV2Page>;
  loadNativeConversationToolResult?(projectId: string, conversationId: string, handle: string, options?: { offset?: number; limit?: number }): Promise<NativeConversationToolResultPage>;
  loadNativeConversationEvents(projectId: string, conversationId: string, options: { afterSequence: number; limit?: number; byteLimit?: number; syncStreamGeneration?: string }): Promise<NativeConversationEventPage>;
  loadNativePendingRequests(projectId: string, conversationId: string): Promise<{ conversationId: string; requests: NativePendingRequest[] }>;
  loadNativeSubagents?(projectId: string, conversationId: string): Promise<NativeSubagentListSnapshot>;
  loadNativeSubagentThread?(projectId: string, conversationId: string, threadId: string): Promise<NativeSubagentThreadSnapshot>;
  loadConversationResourcePreview?(projectId: string, conversationId: string, resourceId: string): Promise<ConversationResourcePreview>;
  loadTurnChangeFilePreview?(projectId: string, conversationId: string, turnId: string, changeSetId: string, fileId: string): Promise<ConversationResourcePreview>;
  loadTurnChangeSet?(projectId: string, conversationId: string, turnId: string): Promise<TurnChangeSet>;
  operateTurnChangeSet?(
    projectId: string,
    conversationId: string,
    turnId: string,
    action: 'undo' | 'reapply',
    input: { changeSetId: string; expectedState: 'applied' | 'undone'; idempotencyKey: string },
  ): Promise<TurnChangeSetOperationResult>;

  restoreArchivedNativeConversation(projectId: string, conversationId: string): Promise<{ acknowledged: true }>;
  updateNativePermissionMode(projectId: string, conversationId: string, permissionMode: NativePermissionMode): Promise<{ acknowledged: true }>;

  updateNativeCollaborationMode(projectId: string, conversationId: string, collaborationMode: NativeCollaborationMode): Promise<{ acknowledged: true }>;
  loadNativeGoal(projectId: string, conversationId: string): Promise<NativeGoalResponse>;
  setNativeGoal(projectId: string, conversationId: string, objective: string): Promise<NativeGoalResponse>;
  pauseNativeGoal(projectId: string, conversationId: string): Promise<NativeGoalResponse>;
  resumeNativeGoal(projectId: string, conversationId: string): Promise<NativeGoalResponse>;
  clearNativeGoal(projectId: string, conversationId: string, confirmUnfinished: boolean): Promise<NativeGoalResponse & { cleared: boolean }>;
  updateNativeNextTurnSettings(projectId: string, conversationId: string, settings: NativeNextTurnSettings): Promise<NativeNextTurnSettings>;
  connectEvents(onEvent: (event: NativeRealtimeEventEnvelope) => void, options?: { afterEventId?: string; conversationId?: string; afterSequence?: number; syncStreamGeneration?: string }): WebSocket;
  sendNativeMessage(projectId: string, conversationId: string, input: SendNativeMessageRequest): Promise<NativeOperationAcceptance>;
  askNativeSideChat?(projectId: string, conversationId: string, input: { selectedText: string; question: string }): Promise<{ answer: string; status: 'completed' | 'interrupted' }>;
  editNativeQueuedSubmission(projectId: string, conversationId: string, submissionId: string, content: string): Promise<NativeQueueSnapshot>;
  retryNativeQueuedSubmission(projectId: string, conversationId: string, submissionId: string): Promise<NativeQueueSnapshot>;
  rerouteNativeQueuedSubmission(projectId: string, conversationId: string, submissionId: string, settings: NativeNextTurnSettings): Promise<NativeQueueSnapshot>;
  deleteNativeQueuedSubmission(projectId: string, conversationId: string, submissionId: string): Promise<NativeQueueSnapshot>;
  reorderNativeQueue(projectId: string, conversationId: string, orderedSubmissionIds: string[]): Promise<NativeQueueSnapshot>;
  sendNativeQueuedNow(projectId: string, conversationId: string, submissionId: string): Promise<NativeOperationAcceptance>;
  resumeNativeQueue(projectId: string, conversationId: string): Promise<NativeQueueSnapshot>;
  recoverNativeQueue(projectId: string, conversationId: string): Promise<NativeQueueSnapshot>;
  interruptNativeTurn(projectId: string, conversationId: string, turnId: string): Promise<NativeOperationAcceptance>;
  respondToNativeRequest(projectId: string, conversationId: string, requestId: string, response: Record<string, unknown>): Promise<{ operation: Record<string, unknown>; request: NativePendingRequest }>;

  snoozeNativeRequest(
    projectId: string,
    conversationId: string,
    requestId: string,
  ): Promise<{
    request: NativePendingRequest;
  }>;

  respondToPlanImplementationRequest(
    projectId: string,
    conversationId: string,
    requestId: string,
    input: { action: 'implement' | 'refine' | 'dismiss'; feedback?: string },
  ): Promise<{
    operation: NativeOperationAcceptance['operation'];
    request: NativePlanImplementationRequest;
    acknowledged: true;
  }>;
}

export interface SessionDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CreateSessionControllerOptions {
  client: SessionControllerClient;
  projectId: string;
  conversationId: string;
  /** 本地首发工作面尚未绑定真实身份时只构造状态，不连接服务端。 */
  enabled?: boolean;
  initialCachedState?: NativeSessionState;
  initialOptimisticState?: NativeSessionState;
  storage?: SessionDraftStorage;
  createId?: () => string;
  reconnectDelay?: (delayMs: number) => Promise<void>;
  markBrowserCommentsSent?: (input: { conversationId: string; tabId: string; commentIds: string[] }) => Promise<unknown>;
}

export interface SessionController {
  start(): Promise<void>;
  reconnect(): Promise<void>;
  dispose(): void;
  subscribe(listener: () => void): () => void;
  getState(): NativeSessionState;
  /** 只读、有界且不含正文的实时同步诊断，用于现场确认 fail-closed 与恢复水位。 */
  getDiagnostics(): SessionControllerDiagnostics;
  setDraft(draft: string): void;
  setAttachments(attachments: NativeConversationAttachment[]): void;
  setBrowserSubmission(browserSubmission: ZeusBrowserPreparedSubmission | null): void;
  setContextDraft(contextDraft: ConversationContextDraft): void;

  send(delivery: 'queue' | 'steer_now', expectedTurnId?: string, settings?: NativeTurnSettingsSelection): Promise<NativeOperationAcceptance | void>;
  editQueuedSubmission(submissionId: string, content: string): Promise<NativeQueueSnapshot>;
  retryQueuedSubmission(submissionId: string): Promise<NativeQueueSnapshot>;
  rerouteQueuedSubmission(submissionId: string, settings: NativeNextTurnSettings): Promise<NativeQueueSnapshot>;
  deleteQueuedSubmission(submissionId: string): Promise<NativeQueueSnapshot>;
  reorderQueue(orderedSubmissionIds: string[]): Promise<NativeQueueSnapshot>;
  sendQueuedNow(submissionId: string): Promise<NativeOperationAcceptance>;
  resumeQueue(): Promise<NativeQueueSnapshot>;
  recoverQueue(): Promise<NativeQueueSnapshot>;

  restoreArchivedConversation(): Promise<NativeConversationSnapshot>;
  interruptActiveTurn(): Promise<NativeOperationAcceptance>;
  respondToRequest(requestId: string, response: Record<string, unknown>): Promise<{ operation: Record<string, unknown>; request: NativePendingRequest }>;

  snoozeRequest(requestId: string): Promise<{ request: NativePendingRequest }>;

  respondToPlanImplementationRequest(
    requestId: string,
    input: {
      action: 'implement' | 'refine' | 'dismiss';
      feedback?: string;
    },
  ): Promise<void>;
  setPermissionMode(permissionMode: NativePermissionMode): Promise<NativeConversationSnapshot>;

  setCollaborationMode(collaborationMode: NativeCollaborationMode): Promise<NativeConversationSnapshot>;
  setNextTurnSettings(settings: NativeNextTurnSettings): Promise<NativeNextTurnSettings>;
  loadEarlierHistory(): Promise<void>;
  loadTurnProcess(turnId: string): Promise<void>;
  loadTurnArtifacts(turnId: string): Promise<void>;
  loadV2Content(handle: string, offset?: number): Promise<NativeConversationContentV2Page>;
  loadV2ToolResult(handle: string, offset?: number): Promise<NativeConversationToolResultPage>;
}

export interface SessionControllerDiagnostics {
  syncProjectionSuspended: boolean;
  lastAppliedSyncEventSequence: number;
  pendingSyncGapEntries: number;
  pendingSyncGapBytes: number;
  pendingRenderDeltaEntries: number;
  pendingRenderDeltaBytes: number;
  hydrationBufferEntries: number;
  hydrationBufferBytes: number;
  realtimeBufferWatermarks: Readonly<Record<string, { entries: number; bytes: number }>>;
}

interface PendingSendEnvelope {
  fingerprint: string;
  content: string;
  displayText: string;
  draft: string;
  attachments: NativeConversationAttachment[];
  composerAttachments: NativeConversationAttachment[];
  browserSubmission: ZeusBrowserPreparedSubmission | null;
  contextDraft: ConversationContextDraft;
  delivery: 'queue' | 'steer_now';
  expectedTurnId?: string;
  model?: string;
  agentKind?: 'codex' | 'pi';
  effort?: string;
  serviceTier?: string | null;
  permissionMode?: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
  idempotencyKey: string;
  clientUserMessageId: string;
  startedAt?: string;
  deliveryState?: 'pending' | 'accepted' | 'failed' | 'uncertain';
  deliveryError?: NativeSessionError;
  acceptance?: NativeOperationAcceptance;
  browserCommentsMarked?: boolean;
}

interface PendingBrowserCommentMark {
  id: string;
  groups: Array<{
    tabId: string;
    commentIds: string[];
  }>;
}

type FailedSendReconciliation = { kind: 'durable'; acceptance: NativeOperationAcceptance } | { kind: 'recovered' } | { kind: 'absent' } | { kind: 'unknown' };

interface PersistedDraft {
  draft: string;
  attachments: NativeConversationAttachment[];
  browserSubmission?: ZeusBrowserPreparedSubmission | null;
  contextDraft?: ConversationContextDraft;
  pendingSend?: PendingSendEnvelope;
  deferredSends?: PendingSendEnvelope[];
  pendingBrowserCommentMarks?: PendingBrowserCommentMark[];
  recoveredSubmissionIds?: string[];
}

interface SocketLifecycle {
  opened: Promise<void>;
  isDisconnected(): boolean;
  markInactive(): void;
}

class SocketDisconnectedDuringHydrationError extends Error {
  constructor() {
    super('Zeus event socket disconnected during authoritative conversation hydration.');
    this.name = 'SocketDisconnectedDuringHydrationError';
  }
}

export function createSessionController(options: CreateSessionControllerOptions): SessionController {
  const storage = options.storage ?? browserStorage();
  const storageKey = `zeus.native-session-draft:${options.projectId}:${options.conversationId}`;
  const persisted = readPersistedDraft(storage, storageKey);
  let pendingSend = persisted.pendingSend ?? null;
  let deferredSends: PendingSendEnvelope[] = (persisted.deferredSends ?? []).map((envelope) => ({
    ...envelope,
    startedAt: envelope.startedAt ?? new Date().toISOString(),
  }));
  let pendingBrowserCommentMarks = persisted.pendingBrowserCommentMarks ?? [];
  const recoveredSubmissionIds = new Set(persisted.recoveredSubmissionIds ?? []);
  const recoveringSubmissionIds = new Set<string>();
  const confirmedRetiredSubmissionIds = new Set<string>();
  const initialCachedState =
    options.initialCachedState?.projectId === options.projectId &&
    options.initialCachedState.conversationId === options.conversationId &&
    options.initialCachedState.snapshot?.projectId === options.projectId &&
    options.initialCachedState.snapshot.id === options.conversationId
      ? options.initialCachedState
      : undefined;
  const initialOptimisticItems = (options.initialOptimisticState?.itemOrder ?? [])
    .map((key) => options.initialOptimisticState?.items[key])
    .filter((item): item is NonNullable<typeof item> => Boolean(item?.optimistic && item.conversationId === options.conversationId));
  const cachedItems = initialCachedState?.items ?? {};
  const optimisticItems = Object.fromEntries(initialOptimisticItems.map((item) => [item.key, { ...item }]));
  const itemOrder = [...new Set([...(initialCachedState?.itemOrder ?? []), ...initialOptimisticItems.map((item) => item.key)])];
  let state: NativeSessionState = {
    ...(initialCachedState ?? createInitialSessionState()),
    transportState: 'disconnected',
    reconnectAttempt: 0,
    projectId: options.projectId,
    conversationId: options.conversationId,
    providerThreadId: initialCachedState?.providerThreadId ?? (initialOptimisticItems.length > 0 ? (options.initialOptimisticState?.providerThreadId ?? null) : null),
    conversationState: initialCachedState?.conversationState ?? options.initialOptimisticState?.conversationState ?? (initialOptimisticItems.length > 0 ? 'starting_turn' : 'native_loading'),
    items: { ...cachedItems, ...optimisticItems },
    itemOrder,
    providerSettings: initialCachedState?.providerSettings ?? (initialOptimisticItems.length > 0 ? (options.initialOptimisticState?.providerSettings ?? null) : null),
    transcriptRevision: (initialCachedState?.transcriptRevision ?? 0) + initialOptimisticItems.filter((item) => !(item.key in cachedItems)).length,
    queue: initialCachedState?.queue ?? options.initialOptimisticState?.queue ?? null,
    draft: persisted.draft || options.initialOptimisticState?.draft || '',
    attachments: persisted.attachments.length > 0 ? persisted.attachments : (options.initialOptimisticState?.attachments ?? []),
    browserSubmission: persisted.browserSubmission ?? options.initialOptimisticState?.browserSubmission ?? null,
    contextDraft: persisted.contextDraft ?? options.initialOptimisticState?.contextDraft ?? structuredClone(emptyConversationContextDraft),
    busyOperation: null,
    error: initialCachedState?.error?.recoveryRequired ? null : (initialCachedState?.error ?? null),
  };
  if ((pendingSend?.deliveryState === 'failed' || pendingSend?.deliveryState === 'uncertain') && pendingSend.deliveryError) {
    const previousConversationState = state.conversationState;
    const startedAt = pendingSend.startedAt ?? new Date().toISOString();
    const deliveryError = pendingSend.deliveryError;
    pendingSend = { ...pendingSend, startedAt };
    state = sessionReducer(state, {
      type: 'send_started',
      clientUserMessageId: pendingSend.clientUserMessageId,
      durableClientUserMessageId: pendingSend.clientUserMessageId,
      draft: pendingSend.displayText,
      attachments: pendingSend.composerAttachments,
      submittedAttachments: pendingSend.attachments,
      browserSubmission: pendingSend.browserSubmission,
      contextDraft: pendingSend.contextDraft,
      browserComments: pendingSend.browserSubmission?.comments ?? [],
      delivery: pendingSend.delivery,
      previousConversationState,
      startedAt,
    });
    state = sessionReducer(state, {
      type: pendingSend.deliveryState === 'failed' ? 'send_failed' : 'send_uncertain',
      clientUserMessageId: pendingSend.clientUserMessageId,
      draft: pendingSend.draft,
      attachments: pendingSend.composerAttachments,
      browserSubmission: pendingSend.browserSubmission,
      contextDraft: pendingSend.contextDraft,
      previousConversationState,
      error: deliveryError,
    });
  }
  if (deferredSends.length > 0) {
    const currentDraft = state.draft;
    const currentAttachments = state.attachments;
    const currentBrowserSubmission = state.browserSubmission;
    const currentContextDraft = state.contextDraft;
    for (const envelope of deferredSends) {
      state = sessionReducer(state, {
        type: 'send_started',
        clientUserMessageId: envelope.clientUserMessageId,
        durableClientUserMessageId: envelope.clientUserMessageId,
        draft: envelope.displayText,
        attachments: envelope.composerAttachments,
        submittedAttachments: envelope.attachments,
        browserSubmission: envelope.browserSubmission,
        contextDraft: envelope.contextDraft,
        browserComments: envelope.browserSubmission?.comments ?? [],
        delivery: envelope.delivery,
        previousConversationState: state.conversationState,
        startedAt: envelope.startedAt ?? new Date().toISOString(),
        queuedUntilHydrated: true,
      });
    }
    state = { ...state, draft: currentDraft, attachments: currentAttachments, browserSubmission: currentBrowserSubmission, contextDraft: currentContextDraft };
  }
  let socket: WebSocket | null = null;
  let socketLifecycle: SocketLifecycle | null = null;
  let realtimeSubscribed = false;
  let realtimeConnectionPromise: Promise<void> | null = null;
  let connectionToken = 0;
  let identityEpoch = 0;
  let disposed = false;
  let startPromise: Promise<void> | null = null;
  let reconnectLoopPromise: Promise<void> | null = null;
  let reconnectLoopEpoch = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveReconnectTimer: ((shouldContinue: boolean) => void) | null = null;
  let requestRefresh: Promise<void> | null = null;
  let requestRefreshAgain = false;
  let requestRefreshRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let requestRefreshRetryAttempt = 0;
  const requestsAwaitingDetails = new Set<string>();
  const resolvedRequestIds = new Set<string>();
  let targetedHydrationBuffer: BufferedRealtimeEvents | null = null;
  let lastAppliedSyncEventSequence = 0;
  let syncProjectionSuspended = false;
  const pendingSyncGapEvents = new Map<number, NativeRealtimeEventEnvelope>();
  const pendingSyncGapEventBytes = new Map<number, number>();
  let pendingSyncGapBytes = 0;
  let syncGapRecoveryPromise: Promise<void> | null = null;
  const pendingRenderDeltas = new Map<string, NativeConversationEvent>();
  const pendingRenderDeltaBytes = new Map<string, number>();
  let pendingRenderBytes = 0;
  // steer 请求确认前保留队列中的可见占位；只有 steering 事件或明确回队事件到达后才交给正常投影。
  const pendingSteeringSubmissions = new Map<string, NativeQueuedSubmission>();
  let renderDeltaTimer: ReturnType<typeof setTimeout> | null = null;
  let activeOperation: { key: string; promise: Promise<unknown> } | null = null;
  let browserCommentMarkFlush: Promise<void> | null = null;
  let nextTurnSettingsWrite: Promise<NativeNextTurnSettings> | null = null;
  let nextTurnSettingsRevision = 0;
  const listeners = new Set<() => void>();
  const createId = options.createId ?? defaultCreateId;
  const realtimeBufferWatermarks = new Map<RealtimeBufferKind, { entries: number; bytes: number; entryBucket: number; byteBucket: number }>();

  function observeRealtimeBufferWatermark(kind: RealtimeBufferKind, entries: number, bytes: number): void {
    const entryBucket = entries > 0 ? Math.floor(Math.log2(entries)) : 0;
    const byteBucket = bytes > 0 ? Math.floor(Math.log2(bytes)) : 0;
    const previous = realtimeBufferWatermarks.get(kind);
    const next = {
      entries: Math.max(previous?.entries ?? 0, entries),
      bytes: Math.max(previous?.bytes ?? 0, bytes),
      entryBucket: Math.max(previous?.entryBucket ?? 0, entryBucket),
      byteBucket: Math.max(previous?.byteBucket ?? 0, byteBucket),
    };
    realtimeBufferWatermarks.set(kind, next);
    if (previous && entryBucket <= previous.entryBucket && byteBucket <= previous.byteBucket) return;
    try {
      performance.measure('zeus.session.realtime_buffer.high_watermark', {
        start: performance.now(),
        duration: 0,
        detail: { kind, entries: next.entries, bytes: next.bytes, ...sessionRealtimeBufferBudget },
      });
    } catch {
      // Performance Timeline 不可用时不改变会话投影语义。
    }
  }

  function clearPendingSyncGapEvents(): void {
    pendingSyncGapEvents.clear();
    pendingSyncGapEventBytes.clear();
    pendingSyncGapBytes = 0;
  }

  function deletePendingSyncGapEvent(sequence: number): void {
    const bytes = pendingSyncGapEventBytes.get(sequence) ?? 0;
    if (!pendingSyncGapEvents.delete(sequence)) return;
    pendingSyncGapEventBytes.delete(sequence);
    pendingSyncGapBytes = Math.max(0, pendingSyncGapBytes - bytes);
  }

  function queuePendingSyncGapEvent(sequence: number, event: NativeRealtimeEventEnvelope): boolean {
    const existingBytes = pendingSyncGapEventBytes.get(sequence) ?? 0;
    const bytes = estimateNativeRealtimeEventBytes(event);
    const nextEntries = pendingSyncGapEvents.has(sequence) ? pendingSyncGapEvents.size : pendingSyncGapEvents.size + 1;
    const nextBytes = pendingSyncGapBytes - existingBytes + bytes;
    if (nextEntries > sessionRealtimeBufferBudget.maxEntries || nextBytes > sessionRealtimeBufferBudget.maxBytes) {
      clearPendingSyncGapEvents();
      failConversationSync(realtimeBufferBudgetError('sync-gap'));
      return false;
    }
    pendingSyncGapEvents.set(sequence, event);
    pendingSyncGapEventBytes.set(sequence, bytes);
    pendingSyncGapBytes = nextBytes;
    observeRealtimeBufferWatermark('sync-gap', nextEntries, nextBytes);
    return true;
  }

  function clearPendingRenderDeltas(): void {
    pendingRenderDeltas.clear();
    pendingRenderDeltaBytes.clear();
    pendingRenderBytes = 0;
  }

  function dispatch(action: Parameters<typeof sessionReducer>[1]): void {
    const previousThreadId = state.providerThreadId;
    const previousTransportKind = state.snapshot?.transportKind ?? null;
    const next = sessionReducer(state, action);
    if (next === state) return;
    state = next;
    if (state.providerThreadId !== previousThreadId || (state.snapshot?.transportKind ?? null) !== previousTransportKind) identityEpoch += 1;
    for (const listener of listeners) listener();
  }

  function persistDraft(): void {
    if (!storage) return;
    const draft = state.draft;
    const attachments = state.attachments;
    const browserSubmission = state.browserSubmission;
    const contextDraft = state.contextDraft;
    if (!draft && attachments.length === 0 && !browserSubmission && !hasConversationContext(contextDraft) && !pendingSend && deferredSends.length === 0 && pendingBrowserCommentMarks.length === 0 && recoveredSubmissionIds.size === 0) {
      storage.removeItem(storageKey);
      return;
    }
    storage.setItem(
      storageKey,
      JSON.stringify({
        draft,
        attachments,
        ...(browserSubmission ? { browserSubmission } : {}),
        ...(hasConversationContext(contextDraft) ? { contextDraft } : {}),
        ...(pendingSend ? { pendingSend } : {}),
        ...(deferredSends.length > 0 ? { deferredSends } : {}),
        ...(pendingBrowserCommentMarks.length > 0 ? { pendingBrowserCommentMarks } : {}),
        ...(recoveredSubmissionIds.size > 0 ? { recoveredSubmissionIds: [...recoveredSubmissionIds] } : {}),
      } satisfies PersistedDraft),
    );
  }

  function clearDraftIfItStillMatches(envelope: PendingSendEnvelope): void {
    if (
      state.draft !== envelope.draft ||
      !sameAttachments(state.attachments, envelope.composerAttachments) ||
      !sameBrowserSubmission(state.browserSubmission, envelope.browserSubmission) ||
      !sameContextDraft(state.contextDraft, envelope.contextDraft)
    ) {
      return;
    }
    dispatch({ type: 'draft_changed', draft: '' });
    dispatch({ type: 'attachments_changed', attachments: [] });
    dispatch({ type: 'browser_submission_changed', browserSubmission: null });
    dispatch({ type: 'context_draft_changed', contextDraft: structuredClone(emptyConversationContextDraft) });
    recoveredSubmissionIds.clear();
  }

  function restoreRecoveredEnvelopeComposer(envelope: PendingSendEnvelope): void {
    const nextDraft = mergeRecoveredDraftText(state.draft, envelope.draft);
    const nextAttachments = mergeAttachments(state.attachments, envelope.composerAttachments);
    const nextBrowserSubmission = mergeBrowserSubmissions(state.browserSubmission, envelope.browserSubmission);
    const nextContextDraft = mergeConversationContextDraft(state.contextDraft, envelope.contextDraft);
    if (nextDraft !== state.draft) dispatch({ type: 'draft_changed', draft: nextDraft });
    if (!sameAttachments(nextAttachments, state.attachments)) dispatch({ type: 'attachments_changed', attachments: nextAttachments });
    if (!sameBrowserSubmission(nextBrowserSubmission, state.browserSubmission)) dispatch({ type: 'browser_submission_changed', browserSubmission: nextBrowserSubmission });
    if (!sameContextDraft(nextContextDraft, state.contextDraft)) dispatch({ type: 'context_draft_changed', contextDraft: nextContextDraft });
  }

  async function recoverManualConfirmationQueue(queue: NativeQueueSnapshot): Promise<void> {
    const recoverable = queue.submissions.filter(isManualConfirmationSubmission).sort((left, right) => left.position - right.position || (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id));
    if (recoverable.length === 0) return;

    const unseen = recoverable.filter((submission) => !recoveredSubmissionIds.has(submission.id));
    if (unseen.length > 0) {
      const matchingEnvelope = pendingSend && unseen.some((submission) => submission.clientUserMessageId === pendingSend?.clientUserMessageId) ? pendingSend : null;
      const recoveredText = unseen
        .map((submission) => (matchingEnvelope && submission.clientUserMessageId === matchingEnvelope.clientUserMessageId ? matchingEnvelope.draft : composerDraftFromQueuedSubmission(submission)).trim())
        .filter(Boolean)
        .join('\n\n');
      const nextDraft = mergeRecoveredDraftText(state.draft, recoveredText);
      const nextAttachments = mergeAttachments(
        state.attachments,
        unseen.flatMap((submission) => (matchingEnvelope && submission.clientUserMessageId === matchingEnvelope.clientUserMessageId ? matchingEnvelope.composerAttachments : composerAttachmentsFromQueuedSubmission(submission))),
      );
      let nextBrowserSubmission = state.browserSubmission;
      let nextContextDraft = state.contextDraft;
      for (const submission of unseen) {
        const envelopeMatches = matchingEnvelope && submission.clientUserMessageId === matchingEnvelope.clientUserMessageId;
        nextBrowserSubmission = mergeBrowserSubmissions(nextBrowserSubmission, envelopeMatches ? matchingEnvelope.browserSubmission : browserSubmissionFromQueuedSubmission(submission));
        nextContextDraft = mergeConversationContextDraft(nextContextDraft, envelopeMatches ? matchingEnvelope.contextDraft : (submission.conversationContext ?? structuredClone(emptyConversationContextDraft)));
      }
      dispatch({ type: 'draft_changed', draft: nextDraft });
      dispatch({ type: 'attachments_changed', attachments: nextAttachments });
      if (!sameBrowserSubmission(nextBrowserSubmission, state.browserSubmission)) dispatch({ type: 'browser_submission_changed', browserSubmission: nextBrowserSubmission });
      if (!sameContextDraft(nextContextDraft, state.contextDraft)) dispatch({ type: 'context_draft_changed', contextDraft: nextContextDraft });
      unseen.forEach((submission) => recoveredSubmissionIds.add(submission.id));
      if (!storage) return;
      try {
        persistDraft();
      } catch {
        // 草稿没有先持久化成功时保留服务端提交，避免恢复确认过程中丢失用户输入。
        unseen.forEach((submission) => recoveredSubmissionIds.delete(submission.id));
        return;
      }
    }

    if (!storage) return;
    let projectedQueue = queue;
    for (const submission of recoverable) {
      if (recoveringSubmissionIds.has(submission.id)) continue;
      // 草稿已经成功持久化后，先在本地原子撤下同一条乐观消息；服务端删除失败仍保留队列记录供后续重试。
      dispatch({
        type: 'queued_submission_deleted',
        submissionId: submission.id,
        ...(submission.clientUserMessageId ? { clientUserMessageId: submission.clientUserMessageId } : {}),
        queue: projectedQueue,
      });
      recoveringSubmissionIds.add(submission.id);
      try {
        const nextQueue = await options.client.deleteNativeQueuedSubmission(options.projectId, options.conversationId, submission.id);
        if (disposed) return;
        if (!nextQueue.submissions.some((entry) => entry.id === submission.id)) {
          confirmedRetiredSubmissionIds.add(submission.id);
          if (submission.clientUserMessageId && retireBrowserCommentMarks(submission.clientUserMessageId)) persistDraft();
        }
        projectedQueue = nextQueue;
        dispatch({
          type: 'queued_submission_deleted',
          submissionId: submission.id,
          ...(submission.clientUserMessageId ? { clientUserMessageId: submission.clientUserMessageId } : {}),
          queue: nextQueue,
        });
      } catch {
        // 删除确认失败时保留服务端记录；下次权威快照会按 submission id 去重并重试。
      } finally {
        recoveringSubmissionIds.delete(submission.id);
      }
    }
  }

  async function applyAuthoritativeQueue(queue: NativeQueueSnapshot): Promise<void> {
    const projectedQueue = queueWithPendingSteering(queue);
    dispatch({ type: 'queue_hydrated', queue: projectedQueue });
    await recoverManualConfirmationQueue(projectedQueue);
  }

  async function applyAuthoritativeSnapshot(snapshot: NativeConversationSnapshot): Promise<void> {
    if (snapshot.conversationSchemaGeneration !== CONVERSATION_SCHEMA_GENERATION || snapshot.syncStreamGeneration !== CONVERSATION_SYNC_STREAM_GENERATION || !Number.isSafeInteger(snapshot.throughEventSeq) || snapshot.throughEventSeq < 0) {
      throw new Error('Zeus Renderer 与本地服务的会话结构代次不匹配，已拒绝猜测旧新字段。');
    }
    lastAppliedSyncEventSequence = snapshot.throughEventSeq;
    for (const sequence of pendingSyncGapEvents.keys()) {
      if (sequence <= snapshot.throughEventSeq) deletePendingSyncGapEvent(sequence);
    }
    const settledSnapshot = settlePendingSteeringFromSnapshot(snapshot);
    const projectedSnapshot = {
      ...withoutResolvedRequests(settledSnapshot),
      queue: queueWithPendingSteering(settledSnapshot.queue),
    };
    dispatch({ type: 'snapshot_hydrated', snapshot: projectedSnapshot });
    await recoverManualConfirmationQueue(projectedSnapshot.queue);
    retireRecoveredBrowserCommentMarks(projectedSnapshot);
  }

  function queueWithPendingSteering(queue: NativeQueueSnapshot): NativeQueueSnapshot {
    if (pendingSteeringSubmissions.size === 0) return queue;
    const submissions = [...queue.submissions];
    let changed = false;
    for (const [submissionId, pending] of pendingSteeringSubmissions) {
      const index = submissions.findIndex((submission) => submission.id === submissionId);
      if (index >= 0) {
        const authoritative = submissions[index]!;
        // queued/paused 是 send-now 明确回队或恢复的结果；不要再用本地“引导中”覆盖它。
        if (authoritative.status !== 'dispatching' || authoritative.providerTurnId) {
          pendingSteeringSubmissions.delete(submissionId);
          continue;
        }
        if (submissions[index] !== pending) {
          submissions[index] = pending;
          changed = true;
        }
        continue;
      }
      submissions.push(pending);
      changed = true;
    }
    return changed ? { ...queue, submissions } : queue;
  }

  function settlePendingSteeringFromSnapshot(snapshot: NativeConversationSnapshot): NativeConversationSnapshot {
    if (pendingSteeringSubmissions.size === 0) return snapshot;
    for (const [submissionId] of pendingSteeringSubmissions) {
      const submission = snapshot.submissions.find((candidate) => candidate.id === submissionId);
      // dispatching 且尚无 provider turn 仍是确认空窗；其他状态已经足以决定下一步投影。
      if (submission && (submission.status !== 'dispatching' || submission.providerTurnId)) pendingSteeringSubmissions.delete(submissionId);
    }
    return snapshot;
  }

  function queueWithSubmission(queue: NativeQueueSnapshot, submission: NativeQueuedSubmission): NativeQueueSnapshot {
    const submissions = queue.submissions.some((entry) => entry.id === submission.id) ? queue.submissions.map((entry) => (entry.id === submission.id ? submission : entry)) : [...queue.submissions, submission];
    return { ...queue, submissions };
  }

  function flushRenderDeltas(): void {
    if (renderDeltaTimer) clearTimeout(renderDeltaTimer);
    renderDeltaTimer = null;
    if (pendingRenderDeltas.size === 0) return;
    const events = [...pendingRenderDeltas.values()];
    clearPendingRenderDeltas();
    for (const event of events) applyEventImmediately(event);
  }

  function queueRenderDelta(event: NativeConversationEvent): void {
    if (!isEventForController(event)) return;
    const key = renderDeltaKey(event);
    if (!key) {
      flushRenderDeltas();
      applyEventImmediately(event);
      return;
    }
    // Map 的删除再写入保留“最后一次到达”的顺序，避免合并后出现跨 item 的旧顺序。
    const existingBytes = pendingRenderDeltaBytes.get(key) ?? 0;
    const eventBytes = estimateNativeRealtimeEventBytes(event);
    const nextEntries = pendingRenderDeltas.has(key) ? pendingRenderDeltas.size : pendingRenderDeltas.size + 1;
    const nextBytes = pendingRenderBytes - existingBytes + eventBytes;
    if (nextEntries > sessionRealtimeBufferBudget.maxEntries || nextBytes > sessionRealtimeBufferBudget.maxBytes) {
      clearPendingRenderDeltas();
      failConversationSync(realtimeBufferBudgetError('render-delta'));
      return;
    }
    pendingRenderDeltas.delete(key);
    pendingRenderDeltas.set(key, event);
    pendingRenderDeltaBytes.set(key, eventBytes);
    pendingRenderBytes = nextBytes;
    observeRealtimeBufferWatermark('render-delta', nextEntries, nextBytes);
    if (!renderDeltaTimer) renderDeltaTimer = setTimeout(flushRenderDeltas, RENDER_DELTA_COALESCE_MS);
  }

  function applyRealtimeEvent(event: NativeRealtimeEventEnvelope): void {
    if (syncProjectionSuspended) return;
    if (targetedHydrationBuffer) {
      if (!appendRealtimeEvent(targetedHydrationBuffer, event)) {
        failConversationSync(realtimeBufferBudgetError('targeted-hydration'));
      } else {
        observeRealtimeBufferWatermark('targeted-hydration', targetedHydrationBuffer.events.length, targetedHydrationBuffer.bytes);
      }
      return;
    }
    if (event.type === 'conversation.sync.baseline_required' || event.type === 'conversation.sync.catch_up_required') {
      if (event.payload.conversationId === options.conversationId) scheduleConversationSyncGapRecovery();
      return;
    }
    if (event.payload.projectId !== options.projectId || event.payload.conversationId !== options.conversationId) return;
    const syncSequence = event.payload.sequence;
    if (!Number.isSafeInteger(syncSequence) || (syncSequence as number) <= 0 || event.payload.conversationSchemaGeneration !== CONVERSATION_SCHEMA_GENERATION || event.payload.syncStreamGeneration !== CONVERSATION_SYNC_STREAM_GENERATION) {
      failConversationSync(new Error('收到无法验证结构代次或连续序号的会话事件，已拒绝继续投影。'));
      return;
    }
    const sequence = syncSequence as number;
    if (sequence <= lastAppliedSyncEventSequence) return;
    if (syncGapRecoveryPromise || sequence !== lastAppliedSyncEventSequence + 1) {
      if (!queuePendingSyncGapEvent(sequence, event)) return;
      flushRenderDeltas();
      scheduleConversationSyncGapRecovery();
      return;
    }
    acceptContiguousRealtimeEvent(event);
  }

  function acceptContiguousRealtimeEvent(event: NativeRealtimeEventEnvelope): void {
    if (
      event.payload.conversationId !== options.conversationId ||
      event.payload.projectId !== options.projectId ||
      event.payload.conversationSchemaGeneration !== CONVERSATION_SCHEMA_GENERATION ||
      event.payload.syncStreamGeneration !== CONVERSATION_SYNC_STREAM_GENERATION ||
      !((typeof event.payload.entityRevision === 'number' && Number.isSafeInteger(event.payload.entityRevision)) || (typeof event.payload.entityRevision === 'string' && event.payload.entityRevision.length > 0))
    ) {
      throw new Error('会话增量事件的会话身份或协议代次不一致。');
    }
    const sequence = event.payload.sequence;
    if (!Number.isSafeInteger(sequence) || (sequence as number) <= lastAppliedSyncEventSequence) return;
    if ((sequence as number) !== lastAppliedSyncEventSequence + 1) throw new Error('会话增量事件序号不连续，已拒绝越过缺口。');
    lastAppliedSyncEventSequence = sequence as number;
    if (!isNativeConversationEvent(event) || !isEventForController(event)) return;
    if (event.type === 'conversation.item.delta') {
      queueRenderDelta(event);
      return;
    }
    // 完成态、请求态和 turn 边界必须先看到之前所有增量；完成事件本身仍立即到达 reducer。
    flushRenderDeltas();
    applyEventImmediately(event);
    queueMicrotask(releaseIdleRealtimeSubscription);
  }

  function scheduleConversationSyncGapRecovery(): void {
    if (disposed || syncGapRecoveryPromise) return;
    const token = connectionToken;
    const recovery = recoverConversationSyncGap(token);
    syncGapRecoveryPromise = recovery;
    void recovery
      .catch((error) => {
        if (!disposed && token === connectionToken) failConversationSync(error);
      })
      .finally(() => {
        if (syncGapRecoveryPromise === recovery) syncGapRecoveryPromise = null;
      });
  }

  async function recoverConversationSyncGap(token: number): Promise<void> {
    let stalledReads = 0;
    while (!disposed && token === connectionToken) {
      const page = await options.client.loadNativeConversationEvents(options.projectId, options.conversationId, {
        afterSequence: lastAppliedSyncEventSequence,
        limit: 1_000,
        byteLimit: 4 * 1024 * 1024,
        syncStreamGeneration: CONVERSATION_SYNC_STREAM_GENERATION,
      });
      if (disposed || token !== connectionToken || syncProjectionSuspended) return;
      if (
        page.conversationId !== options.conversationId ||
        page.conversationSchemaGeneration !== CONVERSATION_SCHEMA_GENERATION ||
        page.syncStreamGeneration !== CONVERSATION_SYNC_STREAM_GENERATION ||
        !Number.isSafeInteger(page.throughEventSeq) ||
        !Number.isSafeInteger(page.nextCursor)
      ) {
        throw new Error('会话增量补拉响应的身份、代次或游标无效。');
      }
      let progressed = false;
      if (page.requestedBeforeBaseline) {
        const snapshot = await loadConversationForHydration();
        if (disposed || token !== connectionToken || syncProjectionSuspended) return;
        await applyAuthoritativeSnapshot(snapshot);
        progressed = true;
      } else {
        for (const event of page.events) {
          const sequence = event.payload.sequence;
          if (!Number.isSafeInteger(sequence)) throw new Error('会话增量补拉响应包含无效序号。');
          if ((sequence as number) <= lastAppliedSyncEventSequence) continue;
          acceptContiguousRealtimeEvent(event);
          progressed = true;
        }
      }
      if (page.hasMore) {
        stalledReads = progressed ? 0 : stalledReads + 1;
        if (stalledReads >= 2) throw new Error('会话增量补拉没有推进游标。');
        continue;
      }

      const buffered = [...pendingSyncGapEvents.entries()].sort(([left], [right]) => left - right);
      clearPendingSyncGapEvents();
      for (const [sequence, event] of buffered) {
        if (sequence <= lastAppliedSyncEventSequence) continue;
        if (sequence !== lastAppliedSyncEventSequence + 1) {
          if (!queuePendingSyncGapEvent(sequence, event)) return;
          continue;
        }
        acceptContiguousRealtimeEvent(event);
        progressed = true;
      }
      if (pendingSyncGapEvents.size === 0) return;
      stalledReads = progressed ? 0 : stalledReads + 1;
      if (stalledReads >= 2) throw new Error('会话增量补拉后仍存在不可跨越的序号缺口。');
    }
  }

  function failConversationSync(error: unknown): void {
    if (disposed || syncProjectionSuspended) return;
    syncProjectionSuspended = true;
    if (renderDeltaTimer) clearTimeout(renderDeltaTimer);
    renderDeltaTimer = null;
    clearPendingRenderDeltas();
    clearPendingSyncGapEvents();
    const token = connectionToken;
    socketLifecycle?.markInactive();
    socketLifecycle = null;
    realtimeSubscribed = false;
    const failedSocket = socket;
    socket = null;
    failedSocket?.close();
    dispatch({ type: 'transport_changed', transportState: 'failed', error: toSessionError(error, true) });
    scheduleReconnect(token);
  }

  function applyEventImmediately(event: NativeConversationEvent): void {
    if (!isEventForController(event)) return;
    const requestId = eventRequestId(event);
    if (event.type === 'conversation.request.resolved' && requestId) {
      markRequestResolved(requestId, event);
      return;
    }
    const suppressRequestAuthority = event.type === 'conversation.request.created' && requestId !== null && resolvedRequestIds.has(requestId);
    if (event.type === 'conversation.submission.steering') {
      const submissionId = typeof event.payload.submissionId === 'string' ? event.payload.submissionId : null;
      if (submissionId) pendingSteeringSubmissions.delete(submissionId);
    }
    const eventQueue = event.type === 'conversation.queue.changed' ? nativeQueueSnapshotFrom(event.payload.queue) : null;
    const projectedEvent: NativeConversationEvent = event.type === 'conversation.queue.changed' && eventQueue ? { ...event, payload: { ...event.payload, queue: queueWithPendingSteering(eventQueue) } } : event;
    dispatch({ type: 'event_received', event: projectedEvent, ...(suppressRequestAuthority ? { suppressRequestAuthority: true } : {}) });
    if (event.type === 'conversation.queue.changed') {
      const queue = eventQueue ? queueWithPendingSteering(eventQueue) : null;
      if (queue) void recoverManualConfirmationQueue(queue);
    }
    if (event.type === 'conversation.request.created' && !suppressRequestAuthority && requestId) {
      if (eventCarriesRequestDetails(event, requestId)) {
        requestsAwaitingDetails.delete(requestId);
      } else {
        requestsAwaitingDetails.add(requestId);
        void refreshPendingRequests();
      }
    }
  }

  function markRequestResolved(requestId: string, event?: NativeConversationEvent): void {
    resolvedRequestIds.add(requestId);
    requestsAwaitingDetails.delete(requestId);
    if (requestsAwaitingDetails.size === 0) cancelPendingRequestRefreshRetry();
    dispatch(event ? { type: 'event_received', event } : { type: 'request_resolved', requestId });
  }

  function resumeEventsAfterRequestResponse(requestId: string): void {
    markRequestResolved(requestId);
    // 用户可能在请求卡片前停留很久，期间本机 WebSocket 已经失活却尚未触发 close。
    // 回答成功后重新建立事件流并读取权威快照，保证行为与 Codex App 一致：
    // 请求解除后继续接收同一轮的后续事件，直到 turn/completed。
    cancelReconnectLoop();
    const attempt = hydrate(true, 'required');
    const token = connectionToken;
    void attempt.catch(() => scheduleReconnect(token));
  }

  function withoutResolvedRequests(snapshot: NativeConversationSnapshot): NativeConversationSnapshot {
    const requests = snapshot.requests.filter((request) => request.status !== 'pending' || !resolvedRequestIds.has(request.id));
    return requests.length === snapshot.requests.length ? snapshot : { ...snapshot, requests };
  }

  function envelopeHasProviderUserFact(snapshot: NativeConversationSnapshot, envelope: PendingSendEnvelope): boolean {
    return snapshot.messages.some((message) => message.metadata.clientUserMessageId === envelope.clientUserMessageId) || snapshot.items.some((item) => snapshotItemClientUserMessageId(item) === envelope.clientUserMessageId);
  }

  function matchingEnvelopeSubmissions(snapshot: NativeConversationSnapshot, envelope: PendingSendEnvelope): NativeQueuedSubmission[] {
    return snapshot.submissions.filter((submission) => submission.clientUserMessageId === envelope.clientUserMessageId);
  }

  function submissionIsDurableEnvelopeEvidence(submission: NativeQueuedSubmission): boolean {
    return submission.status !== 'deleted' && submission.status !== 'cancelled' && !isManualConfirmationSubmission(submission);
  }

  function acceptedEnvelopeIsDurable(snapshot: NativeConversationSnapshot, envelope: PendingSendEnvelope): boolean {
    if (envelopeHasProviderUserFact(snapshot, envelope)) return true;
    return matchingEnvelopeSubmissions(snapshot, envelope).some(submissionIsDurableEnvelopeEvidence);
  }

  function envelopeWasRecoveredToComposer(snapshot: NativeConversationSnapshot, envelope: PendingSendEnvelope): boolean {
    if (!storage || envelopeHasProviderUserFact(snapshot, envelope)) return false;
    const matchingSubmissions = matchingEnvelopeSubmissions(snapshot, envelope);
    if (matchingSubmissions.some(submissionIsDurableEnvelopeEvidence)) return false;
    const snapshotConfirmsRetired = matchingSubmissions.some((submission) => recoveredSubmissionIds.has(submission.id) && (submission.status === 'deleted' || submission.status === 'cancelled'));
    const matchingSubmissionIds = matchingSubmissions.map((submission) => submission.id);
    const acceptedSubmissionId = envelope.acceptance?.submission?.id;
    const deleteResponseConfirmsRetired = [...matchingSubmissionIds, ...(acceptedSubmissionId ? [acceptedSubmissionId] : [])].some(
      (submissionId) => recoveredSubmissionIds.has(submissionId) && confirmedRetiredSubmissionIds.has(submissionId),
    );
    return snapshotConfirmsRetired || deleteResponseConfirmsRetired;
  }

  function envelopeWasDiscardedWithoutProviderFact(snapshot: NativeConversationSnapshot, envelope: PendingSendEnvelope): boolean {
    if (envelopeHasProviderUserFact(snapshot, envelope)) return false;
    const matchingSubmissions = matchingEnvelopeSubmissions(snapshot, envelope);
    return matchingSubmissions.length > 0 && matchingSubmissions.every((submission) => submission.status === 'deleted' || submission.status === 'cancelled');
  }

  function finalizeRecoveredEnvelope(envelope: PendingSendEnvelope): void {
    restoreRecoveredEnvelopeComposer(envelope);
    pendingSend = null;
    dispatch({ type: 'send_succeeded' });
    persistDraft();
  }

  function acceptedStatus(acceptance: NativeOperationAcceptance): string {
    const submissionStatus = acceptance.submission?.status;
    return typeof submissionStatus === 'string' ? submissionStatus : typeof acceptance.operation.status === 'string' ? acceptance.operation.status : 'accepted';
  }

  function dispatchSendAccepted(clientUserMessageId: string, acceptance: NativeOperationAcceptance): void {
    const providerTurnIdValue = acceptance.submission?.providerTurnId ?? acceptance.operation.providerTurnId;
    dispatch({
      type: 'send_accepted',
      clientUserMessageId,
      status: acceptedStatus(acceptance),
      ...(acceptance.submission?.id ? { submissionId: acceptance.submission.id } : {}),
      ...(typeof providerTurnIdValue === 'string' && providerTurnIdValue ? { providerTurnId: providerTurnIdValue } : {}),
    });
  }

  function browserCommentMarkFromEnvelope(envelope: PendingSendEnvelope): PendingBrowserCommentMark | null {
    const browserSubmission = envelope.browserSubmission;
    if (!browserSubmission || envelope.browserCommentsMarked) return null;
    const commentTabById = new Map(browserSubmission.comments.map((comment) => [comment.id, comment.tabId]));
    const commentIdsByTab = new Map<string, Set<string>>();
    for (const commentId of browserSubmission.commentIds) {
      const tabId = commentTabById.get(commentId) || browserSubmission.tabId;
      const commentIds = commentIdsByTab.get(tabId) ?? new Set<string>();
      commentIds.add(commentId);
      commentIdsByTab.set(tabId, commentIds);
    }
    const groups = [...commentIdsByTab].map(([tabId, commentIds]) => ({ tabId, commentIds: [...commentIds] }));
    if (groups.length === 0) return null;
    return {
      id: envelope.clientUserMessageId || envelope.idempotencyKey,
      groups,
    };
  }

  function enqueueBrowserCommentMark(envelope: PendingSendEnvelope): boolean {
    const task = browserCommentMarkFromEnvelope(envelope);
    if (!task) return false;
    const merged = mergePendingBrowserCommentMarks([...pendingBrowserCommentMarks, task]);
    if (JSON.stringify(merged) === JSON.stringify(pendingBrowserCommentMarks)) return false;
    pendingBrowserCommentMarks = merged;
    return true;
  }

  function flushPendingBrowserCommentMarks(): Promise<void> {
    if (browserCommentMarkFlush) return browserCommentMarkFlush;
    const mark =
      options.markBrowserCommentsSent ??
      (typeof window !== 'undefined' && window.zeus?.markBrowserCommentsSent ? (input: { conversationId: string; tabId: string; commentIds: string[] }) => window.zeus!.markBrowserCommentsSent!(input) : undefined);
    if (!mark || pendingBrowserCommentMarks.length === 0) return Promise.resolve();

    const attempted = new Set<string>();
    const attempt = (async () => {
      while (!disposed) {
        const next = pendingBrowserCommentMarks.flatMap((task) => task.groups.map((group) => ({ task, group }))).find(({ task, group }) => !attempted.has(`${task.id}\u0000${group.tabId}`));
        if (!next) return;
        const { task, group } = next;
        attempted.add(`${task.id}\u0000${group.tabId}`);
        try {
          await mark({
            conversationId: options.conversationId,
            tabId: group.tabId,
            commentIds: group.commentIds,
          });
        } catch {
          // 页面暂时不可用时保留独立账本；它不占用发送 envelope，也不会阻塞后续消息。
          continue;
        }
        if (disposed) return;
        pendingBrowserCommentMarks = pendingBrowserCommentMarks.flatMap((candidate) => {
          if (candidate.id !== task.id) return [candidate];
          const groups = candidate.groups.filter((candidateGroup) => candidateGroup.tabId !== group.tabId);
          return groups.length > 0 ? [{ ...candidate, groups }] : [];
        });
        try {
          persistDraft();
        } catch {
          // BrowserHost 已完成幂等标记；旧持久记录会在下次启动时安全重试。
        }
      }
    })();
    const tracked = attempt.finally(() => {
      if (browserCommentMarkFlush === tracked) browserCommentMarkFlush = null;
    });
    browserCommentMarkFlush = tracked;
    return tracked;
  }

  function finalizeDurableEnvelope(envelope: PendingSendEnvelope): void {
    if (pendingSend !== envelope) return;
    const queuedBrowserMark = enqueueBrowserCommentMark(envelope);
    // 先让 accepted envelope 与补偿账本同时落盘；第二阶段失败时仍可从任一身份安全重放。
    if (queuedBrowserMark) persistDraft();
    clearDraftIfItStillMatches(envelope);
    pendingSend = null;
    dispatch({ type: 'send_succeeded' });
    persistDraft();
    void flushPendingBrowserCommentMarks();
  }

  function reservedBrowserCommentIds(allowedPending: PendingSendEnvelope | null = null): Set<string> {
    const reserved = new Set<string>();
    if (pendingSend && pendingSend !== allowedPending) pendingSend.browserSubmission?.commentIds.forEach((commentId) => reserved.add(commentId));
    deferredSends.forEach((envelope) => envelope.browserSubmission?.commentIds.forEach((commentId) => reserved.add(commentId)));
    pendingBrowserCommentMarks.forEach((task) => task.groups.forEach((group) => group.commentIds.forEach((commentId) => reserved.add(commentId))));
    return reserved;
  }

  function browserSubmissionUsesReservedComments(browserSubmission: ZeusBrowserPreparedSubmission | null, allowedPending: PendingSendEnvelope | null = null): boolean {
    if (!browserSubmission) return false;
    const reserved = reservedBrowserCommentIds(allowedPending);
    return browserSubmission.commentIds.some((commentId) => reserved.has(commentId));
  }

  function retireBrowserCommentMarks(clientUserMessageId: string): boolean {
    const remaining = pendingBrowserCommentMarks.filter((task) => task.id !== clientUserMessageId);
    if (remaining.length === pendingBrowserCommentMarks.length) return false;
    pendingBrowserCommentMarks = remaining;
    return true;
  }

  function retireRecoveredBrowserCommentMarks(snapshot: NativeConversationSnapshot): void {
    let changed = false;
    for (const submission of snapshot.submissions) {
      if (
        !submission.clientUserMessageId ||
        !recoveredSubmissionIds.has(submission.id) ||
        (submission.status !== 'deleted' && submission.status !== 'cancelled') ||
        snapshot.messages.some((message) => message.metadata.clientUserMessageId === submission.clientUserMessageId) ||
        snapshot.items.some((item) => snapshotItemClientUserMessageId(item) === submission.clientUserMessageId)
      ) {
        continue;
      }
      changed = retireBrowserCommentMarks(submission.clientUserMessageId) || changed;
    }
    if (changed) persistDraft();
  }

  function projectAcceptedEnvelope(envelope: PendingSendEnvelope): void {
    if (!envelope.acceptance) return;
    dispatch({
      type: 'send_started',
      clientUserMessageId: envelope.clientUserMessageId,
      durableClientUserMessageId: envelope.clientUserMessageId,
      draft: envelope.displayText,
      attachments: envelope.composerAttachments,
      submittedAttachments: envelope.attachments,
      browserSubmission: envelope.browserSubmission,
      contextDraft: envelope.contextDraft,
      browserComments: envelope.browserSubmission?.comments ?? [],
      delivery: envelope.delivery,
      previousConversationState: state.conversationState,
      startedAt: envelope.startedAt ?? new Date().toISOString(),
    });
    dispatchSendAccepted(envelope.clientUserMessageId, envelope.acceptance);
  }

  async function reconcilePersistedAcceptance(snapshot: NativeConversationSnapshot): Promise<void> {
    if (pendingSend?.deliveryState !== 'accepted' || !pendingSend.acceptance) return;
    const envelope = pendingSend;
    if (envelopeWasRecoveredToComposer(snapshot, envelope)) {
      finalizeRecoveredEnvelope(envelope);
      return;
    }
    if (envelopeWasDiscardedWithoutProviderFact(snapshot, envelope)) {
      finalizeRecoveredEnvelope(envelope);
      return;
    }
    if (acceptedEnvelopeIsDurable(snapshot, envelope)) {
      finalizeDurableEnvelope(envelope);
      return;
    }
    // 确认恢复尚未成功持久化时保留 envelope，不能把未进入 Provider 的输入重新投影为已接受消息。
    if (snapshotRequiresManualConfirmation(snapshot, envelope.clientUserMessageId)) return;
    if (!hasNativeOptimisticItem(state, envelope.clientUserMessageId)) projectAcceptedEnvelope(envelope);
  }

  async function reconcileAcceptedSend(): Promise<void> {
    const envelope = pendingSend;
    if (!envelope || envelope.deliveryState !== 'accepted' || !envelope.acceptance || disposed) return;
    const buffered = createRealtimeEventBuffer('targeted-hydration');
    targetedHydrationBuffer = buffered;
    try {
      const snapshot = await loadConversationForHydration();
      if (disposed || pendingSend !== envelope) return;
      await applyAuthoritativeSnapshot(snapshot);
      if (envelopeWasRecoveredToComposer(snapshot, envelope)) {
        finalizeRecoveredEnvelope(envelope);
        return;
      }
      if (envelopeWasDiscardedWithoutProviderFact(snapshot, envelope)) {
        finalizeRecoveredEnvelope(envelope);
        return;
      }
      if (acceptedEnvelopeIsDurable(snapshot, envelope)) {
        finalizeDurableEnvelope(envelope);
      } else {
        dispatch({
          type: 'send_reconciliation_failed',
          error: {
            message: 'The accepted message is waiting for a durable conversation snapshot.',
            code: 'ZEUS_NATIVE_ACCEPTANCE_HYDRATION_PENDING',
            recoveryRequired: false,
            retryable: true,
          },
        });
      }
      persistDraft();
    } catch (error) {
      if (!disposed && pendingSend === envelope) {
        dispatch({
          type: 'send_reconciliation_failed',
          error: {
            ...toSessionError(error, true),
            message: 'The message was accepted, but its durable conversation snapshot is temporarily unavailable.',
            code: 'ZEUS_NATIVE_ACCEPTANCE_HYDRATION_PENDING',
            recoveryRequired: false,
            retryable: true,
          },
        });
        persistDraft();
      }
    } finally {
      if (targetedHydrationBuffer === buffered) targetedHydrationBuffer = null;
      if (!buffered.overflowed) {
        for (const event of buffered.events) applyRealtimeEvent(event);
      }
      buffered.events.length = 0;
      buffered.bytes = 0;
      flushRenderDeltas();
    }
  }

  function acceptanceFromDurableSnapshot(snapshot: NativeConversationSnapshot, envelope: PendingSendEnvelope): NativeOperationAcceptance {
    const submission = snapshot.submissions.find((candidate) => candidate.clientUserMessageId === envelope.clientUserMessageId);
    return {
      operation: {
        status: submission?.status ?? 'accepted',
        recovered: true,
        clientUserMessageId: envelope.clientUserMessageId,
      },
      conversation: {
        id: snapshot.id,
        recovered: true,
      },
      ...(submission
        ? {
            submission: {
              id: submission.id,
              status: submission.status,
              ...(submission.clientUserMessageId ? { clientUserMessageId: submission.clientUserMessageId } : {}),
              ...(submission.providerTurnId ? { providerTurnId: submission.providerTurnId } : {}),
            },
          }
        : {}),
    };
  }

  async function reconcileFailedSend(envelope: PendingSendEnvelope): Promise<FailedSendReconciliation> {
    const buffered = createRealtimeEventBuffer('targeted-hydration');
    targetedHydrationBuffer = buffered;
    try {
      const snapshot = await loadConversationForHydration();
      if (disposed || pendingSend !== envelope) return { kind: 'unknown' };
      await applyAuthoritativeSnapshot(snapshot);
      if (envelopeWasRecoveredToComposer(snapshot, envelope)) {
        finalizeRecoveredEnvelope(envelope);
        return { kind: 'recovered' };
      }
      if (snapshotRequiresManualConfirmation(snapshot, envelope.clientUserMessageId)) return { kind: 'unknown' };
      if (!acceptedEnvelopeIsDurable(snapshot, envelope)) return { kind: 'absent' };

      const acceptance = acceptanceFromDurableSnapshot(snapshot, envelope);
      pendingSend = { ...envelope, deliveryState: 'accepted', acceptance };
      dispatchSendAccepted(envelope.clientUserMessageId, acceptance);
      persistDraft();
      return { kind: 'durable', acceptance };
    } catch {
      return { kind: 'unknown' };
    } finally {
      if (targetedHydrationBuffer === buffered) targetedHydrationBuffer = null;
      if (!buffered.overflowed) {
        for (const event of buffered.events) applyRealtimeEvent(event);
      }
      buffered.events.length = 0;
      buffered.bytes = 0;
      flushRenderDeltas();
    }
  }

  function isEventForController(event: NativeConversationEvent): boolean {
    if (event.payload.projectId !== options.projectId || event.payload.conversationId !== options.conversationId) return false;
    if (event.type === 'conversation.transport.changed' || event.type === 'conversation.thread.changed') return true;
    return !event.payload.threadId || !state.providerThreadId || event.payload.threadId === state.providerThreadId;
  }

  async function refreshPendingRequests(): Promise<void> {
    if (disposed) return;
    if (requestRefresh) {
      requestRefreshAgain = true;
      return requestRefresh;
    }
    const token = connectionToken;
    requestRefresh = (async () => {
      do {
        requestRefreshAgain = false;
        const refreshIdentityEpoch = identityEpoch;
        const snapshot = await options.client.loadNativePendingRequests(options.projectId, options.conversationId);
        if (disposed || token !== connectionToken) return;
        if (refreshIdentityEpoch !== identityEpoch || snapshot.conversationId !== options.conversationId) {
          if (requestRefreshAgain) continue;
          return;
        }
        const requests = snapshot.requests.filter((request) => !resolvedRequestIds.has(request.id));
        dispatch({ type: 'pending_requests_hydrated', requests });
        for (const request of requests) requestsAwaitingDetails.delete(request.id);
      } while (requestRefreshAgain && !disposed && token === connectionToken);
    })()
      .catch(() => {
        schedulePendingRequestRefreshRetry();
      })
      .finally(() => {
        const shouldRefreshAgain = requestRefreshAgain && !disposed;
        requestRefresh = null;
        if (shouldRefreshAgain) {
          requestRefreshAgain = false;
          void refreshPendingRequests();
        } else if (requestsAwaitingDetails.size > 0) {
          schedulePendingRequestRefreshRetry();
        } else {
          cancelPendingRequestRefreshRetry();
        }
      });
    return requestRefresh;
  }

  function schedulePendingRequestRefreshRetry(): void {
    if (disposed || requestsAwaitingDetails.size === 0 || requestRefreshRetryTimer) return;
    const delay = Math.min(4_000, 250 * 2 ** requestRefreshRetryAttempt);
    requestRefreshRetryAttempt = Math.min(5, requestRefreshRetryAttempt + 1);
    requestRefreshRetryTimer = setTimeout(() => {
      requestRefreshRetryTimer = null;
      void refreshPendingRequests();
    }, delay);
  }

  function cancelPendingRequestRefreshRetry(): void {
    if (requestRefreshRetryTimer) clearTimeout(requestRefreshRetryTimer);
    requestRefreshRetryTimer = null;
    requestRefreshRetryAttempt = 0;
  }

  function cancelReconnectLoop(): void {
    reconnectLoopEpoch += 1;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    resolveReconnectTimer?.(false);
    resolveReconnectTimer = null;
    reconnectLoopPromise = null;
  }

  async function waitForReconnectDelay(delayMs: number, epoch: number): Promise<boolean> {
    if (options.reconnectDelay) {
      try {
        await options.reconnectDelay(delayMs);
      } catch {
        return false;
      }
      return !disposed && epoch === reconnectLoopEpoch;
    }
    return new Promise<boolean>((resolve) => {
      resolveReconnectTimer = resolve;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        resolveReconnectTimer = null;
        resolve(!disposed && epoch === reconnectLoopEpoch);
      }, delayMs);
    });
  }

  function scheduleReconnect(token: number): void {
    if (disposed || token !== connectionToken || reconnectLoopPromise || !stateNeedsRealtime()) {
      if (!disposed && token === connectionToken && state.snapshot && !stateNeedsRealtime()) {
        dispatch({ type: 'transport_changed', transportState: 'ready', error: null });
      }
      return;
    }
    const epoch = ++reconnectLoopEpoch;
    const loop = (async () => {
      let attempt = 0;
      while (!disposed && epoch === reconnectLoopEpoch && stateNeedsRealtime()) {
        dispatch({ type: 'transport_changed', transportState: 'reconnecting', reconnectAttempt: attempt + 1 });
        const delayMs = reconnectDelayMs(attempt + 1);
        if (!(await waitForReconnectDelay(delayMs, epoch))) return;
        try {
          await hydrate(true, 'required');
          if (!disposed && epoch === reconnectLoopEpoch && state.transportState === 'ready') return;
        } catch {
          // Keep retrying with capped exponential backoff until a connection succeeds,
          // a manual reconnect replaces this loop, or the controller is disposed.
        }
        attempt += 1;
      }
    })();
    reconnectLoopPromise = loop;
    void loop.finally(() => {
      if (reconnectLoopPromise === loop) reconnectLoopPromise = null;
    });
  }

  function observeSocket(nextSocket: WebSocket, token: number, onDisconnected: () => void): SocketLifecycle {
    let active = true;
    let disconnected = false;
    let opened = nextSocket.readyState === 1;
    let resolveOpen!: () => void;
    let rejectOpen!: (error: Error) => void;
    const openedPromise = opened
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          resolveOpen = resolve;
          rejectOpen = reject;
        });
    const eventTarget = nextSocket as WebSocket & {
      addEventListener?: (type: string, listener: () => void) => void;
      removeEventListener?: (type: string, listener: () => void) => void;
    };

    if (typeof eventTarget.addEventListener !== 'function') {
      return { opened: Promise.resolve(), isDisconnected: () => false, markInactive: () => undefined };
    }

    const handleOpen = (): void => {
      if (!active || opened) return;
      opened = true;
      resolveOpen();
    };
    const handleDisconnect = (): void => {
      if (!active || disconnected) return;
      disconnected = true;
      if (!opened) rejectOpen(new Error('Zeus event socket disconnected before opening.'));
      onDisconnected();
    };
    eventTarget.addEventListener('open', handleOpen);
    eventTarget.addEventListener('close', handleDisconnect);
    eventTarget.addEventListener('error', handleDisconnect);

    return {
      opened: openedPromise,
      isDisconnected: () => disconnected,
      markInactive() {
        active = false;
        eventTarget.removeEventListener?.('open', handleOpen);
        eventTarget.removeEventListener?.('close', handleDisconnect);
        eventTarget.removeEventListener?.('error', handleDisconnect);
      },
    };
  }

  async function loadConversationForHydration(): Promise<NativeConversationSnapshot> {
    const loadSnapshot = options.client.loadNativeConversationV2;
    const loadHistory = options.client.loadNativeConversationModelHistoryV2;
    const loadQueue = options.client.loadNativeConversationQueueV2;
    const loadChoice = options.client.loadNativeConversationChoice;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await loadSnapshot(options.projectId, options.conversationId);
      const [history, queue, pending, choice, goal] = await Promise.all([
        loadHistory(options.projectId, options.conversationId, { direction: 'tail', limit: 48, byteLimit: 96 * 1024 }),
        loadQueue(options.projectId, options.conversationId),
        options.client.loadNativePendingRequests(options.projectId, options.conversationId),
        loadChoice(options.projectId, options.conversationId),
        options.client.loadNativeGoal(options.projectId, options.conversationId),
      ]);
      if (history.throughEventSeq !== snapshot.throughEventSeq) continue;
      return adaptConversationSnapshotV2({ snapshot, history, queue, requests: pending.requests, choice, goal });
    }
    throw new Error('Snapshot V2 结构与尾部历史未能在同一事件水位稳定读取，请重试。');
  }

  function snapshotNeedsRealtime(snapshot: NativeConversationSnapshot): boolean {
    if (snapshot.requests.some((request) => request.status === 'pending')) return true;
    if (snapshot.queue.state.type === 'dispatching' || snapshot.queue.state.type === 'active' || snapshot.queue.state.type === 'waiting') return true;
    if (snapshot.queue.submissions.some((submission) => submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active')) return true;
    return snapshot.turns.some((turn) => turn.status === 'running' || turn.status === 'waiting' || turn.status === 'dispatching');
  }

  function stateNeedsRealtime(): boolean {
    if (pendingSend || deferredSends.length > 0) return true;
    if (state.pendingRequests.some((request) => request.status === 'pending')) return true;
    if (state.queue?.state.type === 'dispatching' || state.queue?.state.type === 'active' || state.queue?.state.type === 'waiting') return true;
    if (state.queue?.submissions.some((submission) => submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active')) return true;
    return (
      state.conversationState === 'starting_turn' ||
      state.conversationState === 'active_prework' ||
      state.conversationState === 'active_final_answer' ||
      state.conversationState === 'waiting_approval' ||
      state.conversationState === 'waiting_user_input'
    );
  }

  function releaseIdleRealtimeSubscription(): void {
    if (disposed || !realtimeSubscribed || stateNeedsRealtime()) return;
    cancelReconnectLoop();
    connectionToken += 1;
    socketLifecycle?.markInactive();
    socketLifecycle = null;
    const idleSocket = socket;
    socket = null;
    realtimeSubscribed = false;
    idleSocket?.close();
    // 本地快照仍然可读且可发送，释放实时订阅不等于会话断线。
    dispatch({ type: 'transport_changed', transportState: 'ready', error: null });
  }

  function ensureRealtimeConnection(): Promise<void> {
    if (disposed || realtimeSubscribed) return Promise.resolve();
    if (realtimeConnectionPromise) return realtimeConnectionPromise;
    cancelReconnectLoop();
    const attempt = hydrate(true, 'required');
    const tracked = attempt.finally(() => {
      if (realtimeConnectionPromise === tracked) realtimeConnectionPromise = null;
    });
    realtimeConnectionPromise = tracked;
    return tracked;
  }

  async function hydrate(reconnecting: boolean, realtimeMode: 'auto' | 'required' = 'auto'): Promise<void> {
    if (disposed) return;
    flushRenderDeltas();
    const token = ++connectionToken;
    socketLifecycle?.markInactive();
    socket?.close();
    socket = null;
    socketLifecycle = null;
    realtimeSubscribed = false;
    dispatch({ type: 'transport_changed', transportState: reconnecting ? 'reconnecting' : 'connecting', error: null });

    const buffered = createRealtimeEventBuffer('hydration');
    let hydrationOverflowError: Error | null = null;
    let hydrating = true;
    let ready = false;
    const onEvent = (event: NativeRealtimeEventEnvelope): void => {
      if (disposed || token !== connectionToken) return;
      const isConversationControl = event.type === 'conversation.sync.baseline_required' || event.type === 'conversation.sync.catch_up_required';
      const isConversationEvent = event.payload.conversationId === options.conversationId && event.payload.projectId === options.projectId;
      if (!isConversationControl && !isConversationEvent) return;
      if (!hydrating) {
        applyRealtimeEvent(event);
        return;
      }
      if (appendRealtimeEvent(buffered, event)) {
        observeRealtimeBufferWatermark('hydration', buffered.events.length, buffered.bytes);
        return;
      }
      if (!hydrationOverflowError) {
        hydrationOverflowError = realtimeBufferBudgetError('hydration');
        failConversationSync(hydrationOverflowError);
      }
    };
    try {
      // 冷打开时先取得完整快照及其事件水位，再从该水位订阅增量。
      // 这样既不会遗漏快照读取期间发生的事件，也不会从 0 重放整段历史并反复撞上 WebSocket 高水位。
      // 已有权威快照时保持稳定的重连状态，不能在 reconnecting/hydrating 间反复切换并触发整页同步闪烁。
      if (!reconnecting || !state.snapshot) dispatch({ type: 'transport_changed', transportState: 'hydrating' });
      const snapshot = await loadConversationForHydration();
      if (disposed || token !== connectionToken) return;
      const subscribeRealtime = realtimeMode === 'required' || snapshotNeedsRealtime(snapshot) || Boolean(pendingSend) || deferredSends.length > 0;
      if (!subscribeRealtime) {
        if (!state.snapshot) markConversationNavigationRenderReady(options.projectId, options.conversationId);
        await applyAuthoritativeSnapshot(snapshot);
        await reconcilePersistedAcceptance(snapshot);
        syncProjectionSuspended = false;
        hydrating = false;
        ready = true;
        dispatch({ type: 'transport_changed', transportState: 'ready', error: null });
        void flushPendingBrowserCommentMarks();
        return;
      }
      const eventOptions = {
        conversationId: options.conversationId,
        afterSequence: snapshot.throughEventSeq,
        syncStreamGeneration: CONVERSATION_SYNC_STREAM_GENERATION,
        ...(reconnecting && state.lastEventId ? { afterEventId: state.lastEventId } : {}),
      };
      const nextSocket = options.client.connectEvents(onEvent, eventOptions);
      socket = nextSocket;
      const lifecycle = observeSocket(nextSocket, token, () => {
        realtimeSubscribed = false;
        if (ready) scheduleReconnect(token);
      });
      socketLifecycle = lifecycle;
      if (hydrationOverflowError) {
        lifecycle.markInactive();
        nextSocket.close();
        throw hydrationOverflowError;
      }
      try {
        await lifecycle.opened;
      } catch (socketError) {
        lifecycle.markInactive();
        if (socket === nextSocket) socket = null;
        nextSocket.close();
        throw socketError;
      }

      if (lifecycle.isDisconnected()) throw new SocketDisconnectedDuringHydrationError();
      if (hydrationOverflowError) throw hydrationOverflowError;
      realtimeSubscribed = true;
      // 只有冷打开需要开放内容首帧；后台重连不能重置已经可见的导航和滚动状态。
      if (!state.snapshot) markConversationNavigationRenderReady(options.projectId, options.conversationId);
      const snapshotAlreadyApplied = reconnecting && state.snapshot?.id === snapshot.id && state.snapshot.throughEventSeq === snapshot.throughEventSeq && state.snapshot.syncStreamGeneration === snapshot.syncStreamGeneration;
      if (!snapshotAlreadyApplied) await applyAuthoritativeSnapshot(snapshot);
      await reconcilePersistedAcceptance(snapshot);
      syncProjectionSuspended = false;
      for (const event of buffered.events) applyRealtimeEvent(event);
      buffered.events.length = 0;
      buffered.bytes = 0;
      hydrating = false;
      ready = true;
      dispatch({ type: 'transport_changed', transportState: 'ready', error: null });
      void flushPendingBrowserCommentMarks();
      void flushDeferredSends();
    } catch (error) {
      hydrating = false;
      const shouldScheduleReconnect = !disposed && token === connectionToken && (error instanceof SocketDisconnectedDuringHydrationError || socketLifecycle?.isDisconnected() === true);
      if (!disposed && token === connectionToken) {
        socketLifecycle?.markInactive();
        socketLifecycle = null;
        const failedSocket = socket;
        socket = null;
        realtimeSubscribed = false;
        failedSocket?.close();
        if (!state.snapshot) markConversationNavigationRenderReady(options.projectId, options.conversationId);
        dispatch({ type: 'transport_changed', transportState: 'failed', error: toSessionError(error, true) });
      }
      if (shouldScheduleReconnect) scheduleReconnect(token);
      throw error;
    }
  }

  function runOperation<T>(key: string, execute: () => Promise<T>, apply: (result: T) => void | Promise<void>, clearErrorOnSuccess = true): Promise<T> {
    if (activeOperation) {
      if (activeOperation.key === key) return activeOperation.promise as Promise<T>;
      return Promise.reject(new Error(`Session operation already in progress: ${activeOperation.key}`));
    }
    dispatch({ type: 'operation_started', operation: key });
    const promise = execute()
      .then(async (result) => {
        await apply(result);
        dispatch({ type: 'operation_finished', operation: key, ...(clearErrorOnSuccess ? { error: null } : {}) });
        return result;
      })
      .catch((error) => {
        const sessionError = toSessionError(error, true);
        dispatch({ type: 'operation_finished', operation: key, error: sessionError });
        persistDraft();
        throw error;
      })
      .finally(() => {
        if (activeOperation?.promise === promise) activeOperation = null;
      });
    activeOperation = { key, promise };
    return promise;
  }

  function submitEnvelope(envelope: PendingSendEnvelope): Promise<NativeOperationAcceptance | void> {
    pendingSend = envelope;
    persistDraft();
    const operation = `send:${envelope.fingerprint}`;
    const previousConversationState = state.conversationState;
    return runOperation(
      operation,
      async () => {
        dispatch({
          type: 'send_started',
          clientUserMessageId: envelope.clientUserMessageId,
          durableClientUserMessageId: envelope.clientUserMessageId,
          draft: envelope.displayText,
          attachments: envelope.composerAttachments,
          submittedAttachments: envelope.attachments,
          browserSubmission: envelope.browserSubmission,
          contextDraft: envelope.contextDraft,
          browserComments: envelope.browserSubmission?.comments ?? [],
          delivery: envelope.delivery,
          previousConversationState,
          startedAt: envelope.startedAt ?? new Date().toISOString(),
        });
        if (envelope.deliveryState === 'accepted' && envelope.acceptance) {
          dispatchSendAccepted(envelope.clientUserMessageId, envelope.acceptance);
          return envelope.acceptance;
        }
        try {
          const acceptance = await options.client.sendNativeMessage(options.projectId, options.conversationId, {
            content: envelope.content,
            ...(envelope.displayText ? { displayText: envelope.displayText } : {}),
            composerDraft: envelope.draft,
            attachments: envelope.attachments,
            ...(envelope.browserSubmission?.comments.length ? { browserComments: envelope.browserSubmission.comments } : {}),
            ...(envelope.browserSubmission ? { browserCommentContent: envelope.browserSubmission.content } : {}),
            ...(hasConversationContext(envelope.contextDraft) ? { conversationContext: envelope.contextDraft } : {}),
            delivery: envelope.delivery,
            ...(envelope.expectedTurnId ? { expectedTurnId: envelope.expectedTurnId } : {}),
            ...(envelope.model ? { model: envelope.model } : {}),
            ...(envelope.agentKind ? { agentKind: envelope.agentKind } : {}),
            ...(envelope.effort ? { effort: envelope.effort } : {}),
            ...(Object.prototype.hasOwnProperty.call(envelope, 'serviceTier') ? { serviceTier: envelope.serviceTier } : {}),
            ...(envelope.permissionMode ? { permissionMode: envelope.permissionMode } : {}),
            collaborationMode: envelope.collaborationMode,
            idempotencyKey: envelope.idempotencyKey,
            clientUserMessageId: envelope.clientUserMessageId,
          });
          pendingSend = { ...envelope, deliveryState: 'accepted', acceptance };
          dispatchSendAccepted(envelope.clientUserMessageId, acceptance);
          persistDraft();
          return acceptance;
        } catch (error) {
          const reconciliation = await reconcileFailedSend(envelope);
          if (reconciliation.kind === 'durable') return reconciliation.acceptance;
          if (reconciliation.kind === 'recovered') return;
          const sessionError = toSessionError(error, true);
          pendingSend = {
            ...envelope,
            deliveryState: reconciliation.kind === 'unknown' ? 'uncertain' : 'failed',
            deliveryError: sessionError,
          };
          dispatch(
            reconciliation.kind === 'unknown'
              ? {
                  type: 'send_uncertain',
                  clientUserMessageId: envelope.clientUserMessageId,
                  draft: envelope.draft,
                  attachments: envelope.composerAttachments,
                  browserSubmission: envelope.browserSubmission,
                  contextDraft: envelope.contextDraft,
                  previousConversationState,
                  error: sessionError,
                }
              : {
                  type: 'send_failed',
                  clientUserMessageId: envelope.clientUserMessageId,
                  draft: envelope.draft,
                  attachments: envelope.composerAttachments,
                  browserSubmission: envelope.browserSubmission,
                  contextDraft: envelope.contextDraft,
                  previousConversationState,
                  error: sessionError,
                },
          );
          persistDraft();
          throw error;
        }
      },
      () => reconcileAcceptedSend(),
      false,
    );
  }

  async function flushDeferredSends(): Promise<void> {
    if (disposed || state.transportState !== 'ready' || !state.snapshot || activeOperation || pendingSend) return;
    while (!disposed && state.transportState === 'ready' && state.snapshot && deferredSends.length > 0 && !activeOperation && !pendingSend) {
      const envelope = deferredSends[0]!;
      deferredSends = deferredSends.slice(1);
      persistDraft();
      try {
        await submitEnvelope(envelope);
      } catch {
        return;
      }
    }
  }

  function dispatchV2Snapshot(snapshot: NativeConversationSnapshot): void {
    if (disposed || state.snapshot?.id !== snapshot.id || snapshot.id !== options.conversationId) return;
    // 按需页不拥有 durable event 水位，只合并展示投影；不得重置 gap-recovery 游标。
    dispatch({ type: 'snapshot_hydrated', snapshot });
  }

  async function loadEarlierHistoryV2(): Promise<void> {
    const load = options.client.loadNativeConversationModelHistoryV2;
    const current = state.snapshot;
    const history = current?.v2Paging?.history;
    if (!load || !current?.snapshotV2 || !history || history.loading || !history.hasMore || !history.nextCursor) return;
    dispatchV2Snapshot(
      updateConversationV2Paging(current, (paging) => ({
        ...paging,
        history: { ...paging.history, loading: true, error: null },
      })),
    );
    try {
      const page = await load(options.projectId, options.conversationId, { cursor: history.nextCursor, direction: 'tail', limit: 48, byteLimit: 96 * 1024 });
      const latest = state.snapshot;
      if (!latest?.snapshotV2 || !latest.v2Paging) return;
      dispatchV2Snapshot(mergeConversationHistoryV2(latest, page));
    } catch (error) {
      const latest = state.snapshot;
      if (latest?.v2Paging) {
        dispatchV2Snapshot(
          updateConversationV2Paging(latest, (paging) => ({
            ...paging,
            history: { ...paging.history, loading: false, error: errorMessage(error) },
          })),
        );
      }
      throw error;
    }
  }

  async function loadTurnProcessV2(turnIdentity: string): Promise<void> {
    const load = options.client.loadNativeConversationProcessV2;
    const current = state.snapshot;
    if (!load || !current?.snapshotV2 || !current.v2Paging) return;
    const turn = current.turns.find((candidate) => candidate.id === turnIdentity || candidate.providerTurnId === turnIdentity);
    if (!turn) return;
    const pagingKey = turn.providerTurnId ?? turn.id;
    const currentPage = current.v2Paging.processByTurn[pagingKey];
    if (currentPage?.loading || (currentPage?.loaded && !currentPage.hasMore)) return;
    dispatchV2Snapshot(
      updateConversationV2Paging(current, (paging) => ({
        ...paging,
        processByTurn: {
          ...paging.processByTurn,
          [pagingKey]: { nextCursor: currentPage?.nextCursor ?? null, hasMore: currentPage?.hasMore ?? true, loading: true, loaded: currentPage?.loaded ?? false, error: null },
        },
      })),
    );
    try {
      const page = await load(options.projectId, options.conversationId, turn.id, {
        ...(currentPage?.nextCursor ? { cursor: currentPage.nextCursor } : {}),
        limit: 32,
        byteLimit: 96 * 1024,
      });
      const latest = state.snapshot;
      if (!latest?.snapshotV2 || !latest.v2Paging) return;
      dispatchV2Snapshot(mergeConversationProcessV2(latest, pagingKey, page));
    } catch (error) {
      const latest = state.snapshot;
      if (latest?.v2Paging) {
        dispatchV2Snapshot(
          updateConversationV2Paging(latest, (paging) => ({
            ...paging,
            processByTurn: {
              ...paging.processByTurn,
              [pagingKey]: { nextCursor: currentPage?.nextCursor ?? null, hasMore: currentPage?.hasMore ?? true, loading: false, loaded: currentPage?.loaded ?? false, error: errorMessage(error) },
            },
          })),
        );
      }
      throw error;
    }
  }

  async function loadTurnArtifactsV2(turnIdentity: string): Promise<void> {
    const current = state.snapshot;
    if (!current?.snapshotV2 || !current.v2Paging) return;
    const turn = current.turns.find((candidate) => candidate.id === turnIdentity || candidate.providerTurnId === turnIdentity);
    if (!turn) return;
    const pagingKey = turn.providerTurnId ?? turn.id;
    const currentChange = current.v2Paging.changeSetsByTurn[pagingKey];
    const resources = current.v2Paging.resources;
    if (currentChange?.loading || resources.loading) return;
    const v2Turn = [...current.snapshotV2.recentClosedTurns, ...(current.snapshotV2.activeTurn ? [current.snapshotV2.activeTurn] : [])].find((candidate) => candidate.id === turn.id);
    const shouldLoadResources = Boolean(options.client.loadNativeConversationResourcesV2 && (!resources.loaded || resources.hasMore));
    const shouldLoadChange = Boolean(v2Turn?.changeSetAvailable && options.client.loadNativeConversationChangeSetV2 && options.client.loadNativeConversationChangeFilesV2 && (!currentChange?.loaded || currentChange.hasMore));
    if (!shouldLoadResources && !shouldLoadChange) return;
    dispatchV2Snapshot(
      updateConversationV2Paging(current, (paging) => ({
        ...paging,
        resources: shouldLoadResources ? { ...paging.resources, loading: true, error: null } : paging.resources,
        changeSetsByTurn: {
          ...paging.changeSetsByTurn,
          [pagingKey]: shouldLoadChange
            ? {
                loading: true,
                loaded: currentChange?.loaded ?? false,
                error: null,
                summary: currentChange?.summary ?? null,
                files: currentChange?.files ?? [],
                nextCursor: currentChange?.nextCursor ?? null,
                hasMore: currentChange?.hasMore ?? true,
              }
            : (currentChange ?? { loading: false, loaded: true, error: null, summary: null, files: [], nextCursor: null, hasMore: false }),
        },
      })),
    );
    try {
      const resourcePromise = shouldLoadResources
        ? options.client.loadNativeConversationResourcesV2!(options.projectId, options.conversationId, {
            ...(resources.nextCursor ? { cursor: resources.nextCursor } : {}),
            limit: 32,
            byteLimit: 64 * 1024,
          })
        : Promise.resolve(null);
      const changePromise = shouldLoadChange
        ? (async () => {
            const summary = currentChange?.summary ?? (await options.client.loadNativeConversationChangeSetV2!(options.projectId, options.conversationId, turn.id));
            const files = await options.client.loadNativeConversationChangeFilesV2!(options.projectId, options.conversationId, turn.id, summary.id, {
              ...(currentChange?.nextCursor ? { cursor: currentChange.nextCursor } : {}),
              limit: 32,
              byteLimit: 64 * 1024,
            });
            return { summary, files };
          })()
        : Promise.resolve(null);
      const [resourcePage, changePage] = await Promise.all([resourcePromise, changePromise]);
      const latest = state.snapshot;
      if (!latest?.snapshotV2 || !latest.v2Paging) return;
      dispatchV2Snapshot(
        updateConversationV2Paging(latest, (paging) => {
          const resourceItems = resourcePage ? dedupeById([...paging.resources.items, ...resourcePage.items]) : paging.resources.items;
          const previousChange = paging.changeSetsByTurn[pagingKey];
          return {
            ...paging,
            resources: resourcePage ? { nextCursor: resourcePage.nextCursor, hasMore: resourcePage.hasMore, loading: false, loaded: true, error: null, items: resourceItems } : paging.resources,
            changeSetsByTurn: {
              ...paging.changeSetsByTurn,
              [pagingKey]: changePage
                ? {
                    loading: false,
                    loaded: true,
                    error: null,
                    summary: changePage.summary,
                    files: dedupeById([...(previousChange?.files ?? []), ...changePage.files.items]),
                    nextCursor: changePage.files.nextCursor,
                    hasMore: changePage.files.hasMore,
                  }
                : (previousChange ?? { loading: false, loaded: true, error: null, summary: null, files: [], nextCursor: null, hasMore: false }),
            },
          };
        }),
      );
    } catch (error) {
      const latest = state.snapshot;
      if (latest?.v2Paging) {
        dispatchV2Snapshot(
          updateConversationV2Paging(latest, (paging) => ({
            ...paging,
            resources: shouldLoadResources ? { ...paging.resources, loading: false, error: errorMessage(error) } : paging.resources,
            changeSetsByTurn: {
              ...paging.changeSetsByTurn,
              [pagingKey]: {
                ...(paging.changeSetsByTurn[pagingKey] ?? { loaded: false, summary: null, files: [], nextCursor: null, hasMore: true }),
                loading: false,
                error: errorMessage(error),
              },
            },
          })),
        );
      }
      throw error;
    }
  }

  const controller: SessionController = {
    start() {
      if (state.transportState === 'ready') return Promise.resolve();
      if (!startPromise) {
        cancelReconnectLoop();
        const attempt = hydrate(false);
        const tracked = attempt.finally(() => {
          if (startPromise === tracked) startPromise = null;
        });
        startPromise = tracked;
      }
      return startPromise;
    },
    reconnect() {
      cancelReconnectLoop();
      dispatch({ type: 'transport_changed', transportState: 'reconnecting', reconnectAttempt: 1 });
      return hydrate(true, 'required');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (renderDeltaTimer) clearTimeout(renderDeltaTimer);
      renderDeltaTimer = null;
      clearPendingRenderDeltas();
      clearPendingSyncGapEvents();
      if (targetedHydrationBuffer) {
        targetedHydrationBuffer.events.length = 0;
        targetedHydrationBuffer.bytes = 0;
      }
      targetedHydrationBuffer = null;
      syncGapRecoveryPromise = null;
      pendingSteeringSubmissions.clear();
      cancelPendingRequestRefreshRetry();
      requestsAwaitingDetails.clear();
      cancelReconnectLoop();
      connectionToken += 1;
      socketLifecycle?.markInactive();
      socketLifecycle = null;
      socket?.close();
      socket = null;
      realtimeSubscribed = false;
      realtimeConnectionPromise = null;
      listeners.clear();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    getDiagnostics: () => ({
      syncProjectionSuspended,
      lastAppliedSyncEventSequence,
      pendingSyncGapEntries: pendingSyncGapEvents.size,
      pendingSyncGapBytes,
      pendingRenderDeltaEntries: pendingRenderDeltas.size,
      pendingRenderDeltaBytes: pendingRenderBytes,
      hydrationBufferEntries: targetedHydrationBuffer?.events.length ?? 0,
      hydrationBufferBytes: targetedHydrationBuffer?.bytes ?? 0,
      realtimeBufferWatermarks: Object.fromEntries([...realtimeBufferWatermarks].map(([kind, value]) => [kind, { entries: value.entries, bytes: value.bytes }])),
    }),
    setDraft(draft) {
      if (pendingSend && pendingSend.deliveryState !== 'accepted' && pendingSend.draft !== draft) pendingSend = null;
      dispatch({ type: 'draft_changed', draft });
      persistDraft();
    },
    setAttachments(attachments) {
      if (pendingSend && pendingSend.deliveryState !== 'accepted' && !sameAttachments(pendingSend.composerAttachments, attachments)) pendingSend = null;
      dispatch({ type: 'attachments_changed', attachments: [...attachments] });
      persistDraft();
    },
    setBrowserSubmission(browserSubmission) {
      if (browserSubmission && !sameBrowserSubmission(state.browserSubmission, browserSubmission) && browserSubmissionUsesReservedComments(browserSubmission)) {
        throw new Error('These browser comments already belong to a pending or delivered message.');
      }
      if (pendingSend && pendingSend.deliveryState !== 'accepted' && !sameBrowserSubmission(pendingSend.browserSubmission, browserSubmission)) {
        pendingSend = null;
      }
      dispatch({
        type: 'browser_submission_changed',
        browserSubmission: browserSubmission ? structuredClone(browserSubmission) : null,
      });
      persistDraft();
    },
    setContextDraft(contextDraft) {
      if (pendingSend && pendingSend.deliveryState !== 'accepted' && !sameContextDraft(pendingSend.contextDraft, contextDraft)) pendingSend = null;
      dispatch({ type: 'context_draft_changed', contextDraft: structuredClone(contextDraft) });
      persistDraft();
    },
    setPermissionMode(permissionMode) {
      if (state.conversationState !== 'native_idle' || state.transportState !== 'ready') return Promise.reject(new Error('Conversation permission mode can change only while the conversation is idle.'));
      return runOperation(
        `permission-mode:${permissionMode}`,
        async () => {
          await options.client.updateNativePermissionMode(options.projectId, options.conversationId, permissionMode);
          return loadConversationForHydration();
        },
        (snapshot) => applyAuthoritativeSnapshot(snapshot),
      );
    },
    setCollaborationMode(collaborationMode) {
      return runOperation(
        `collaboration-mode:${collaborationMode}`,
        async () => {
          await options.client.updateNativeCollaborationMode(options.projectId, options.conversationId, collaborationMode);
          return loadConversationForHydration();
        },
        (snapshot) => applyAuthoritativeSnapshot(snapshot),
      );
    },
    setNextTurnSettings(settings) {
      const revision = ++nextTurnSettingsRevision;
      // 同一会话的快速连续选择必须按用户操作顺序落盘，避免较慢的旧请求最后返回并覆盖新选择。
      const previous = nextTurnSettingsWrite;
      const write = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => options.client.updateNativeNextTurnSettings(options.projectId, options.conversationId, settings));
      nextTurnSettingsWrite = write;
      return write.then((updated) => {
        if (!disposed && revision === nextTurnSettingsRevision) dispatch({ type: 'next_turn_settings_changed', settings: updated });
        return updated;
      });
    },
    send(delivery, expectedTurnId, settings) {
      const normalizedExpectedTurnId = expectedTurnId || undefined;
      const requestedCollaborationMode = settings?.collaborationMode ?? state.snapshot?.collaborationMode ?? 'default';
      const requestedPermissionMode = settings?.permissionMode ?? state.snapshot?.nextTurnSettings?.permissionMode ?? state.snapshot?.permissionMode;
      if (activeOperation) {
        const pendingOperation = pendingSend ? `send:${pendingSend.fingerprint}` : null;
        if (
          pendingSend &&
          activeOperation.key === pendingOperation &&
          pendingSend.delivery === delivery &&
          pendingSend.expectedTurnId === normalizedExpectedTurnId &&
          pendingSend.model === settings?.model &&
          pendingSend.agentKind === settings?.agentKind &&
          pendingSend.effort === settings?.effort &&
          pendingSend.serviceTier === settings?.serviceTier &&
          pendingSend.permissionMode === requestedPermissionMode &&
          pendingSend.collaborationMode === requestedCollaborationMode
        ) {
          return activeOperation.promise as Promise<NativeOperationAcceptance | void>;
        }
        return Promise.reject(new Error(`Session operation already in progress: ${activeOperation.key}`));
      }
      const draft = state.draft;
      const composerAttachments = [...state.attachments];
      const browserSubmission = state.browserSubmission ? structuredClone(state.browserSubmission) : null;
      const contextDraft = structuredClone(state.contextDraft);
      if (!draft.trim() && composerAttachments.length === 0 && !browserSubmission && !hasConversationContext(contextDraft)) {
        return Promise.reject(new Error('Conversation message content, attachments, comments, or annotations are required.'));
      }
      const attachments = mergeAttachments(composerAttachments, browserSubmission?.attachments ?? []);
      const displayText = draft.trim() || (browserSubmission ? `Browser comments (${browserSubmission.commentIds.length})` : '') || (contextDraft.codeComments.length ? '代码评论' : '回答批注');
      const content = [draft.trim(), browserSubmission?.content.trim(), serializeConversationContext(contextDraft)].filter(Boolean).join('\n\n');
      const appliedSettings = delivery === 'queue' ? settings : undefined;
      const fingerprint = sendFingerprint({
        content,
        displayText,
        attachments,
        ...(browserSubmission?.comments.length ? { browserComments: browserSubmission.comments } : {}),
        ...(hasConversationContext(contextDraft) ? { conversationContext: contextDraft } : {}),
        delivery,
        ...(normalizedExpectedTurnId ? { expectedTurnId: normalizedExpectedTurnId } : {}),
        ...(appliedSettings?.model ? { model: appliedSettings.model } : {}),
        ...(appliedSettings?.agentKind ? { agentKind: appliedSettings.agentKind } : {}),
        ...(appliedSettings?.effort ? { effort: appliedSettings.effort } : {}),
        ...(appliedSettings && Object.prototype.hasOwnProperty.call(appliedSettings, 'serviceTier') ? { serviceTier: appliedSettings.serviceTier } : {}),
        ...(appliedSettings ? { permissionMode: appliedSettings.permissionMode } : {}),
        collaborationMode: requestedCollaborationMode,
      });
      const reusableIdentity =
        pendingSend &&
        pendingSend.deliveryState !== 'accepted' &&
        pendingSend.content === content &&
        pendingSend.displayText === displayText &&
        pendingSend.draft === draft &&
        sameAttachments(pendingSend.attachments, attachments) &&
        sameAttachments(pendingSend.composerAttachments, composerAttachments) &&
        sameBrowserSubmission(pendingSend.browserSubmission, browserSubmission) &&
        sameContextDraft(pendingSend.contextDraft, contextDraft) &&
        pendingSend.delivery === delivery &&
        pendingSend.expectedTurnId === normalizedExpectedTurnId &&
        pendingSend.model === appliedSettings?.model &&
        pendingSend.agentKind === appliedSettings?.agentKind &&
        pendingSend.effort === appliedSettings?.effort &&
        pendingSend.permissionMode === (appliedSettings ? appliedSettings.permissionMode : undefined) &&
        pendingSend.collaborationMode === requestedCollaborationMode
          ? pendingSend
          : null;
      const exactPending = pendingSend?.fingerprint === fingerprint ? pendingSend : null;
      if (pendingSend?.deliveryState === 'accepted' && !exactPending) {
        return Promise.reject(new Error('The previous accepted message is still waiting for its authoritative conversation snapshot.'));
      }
      if (browserSubmissionUsesReservedComments(browserSubmission, exactPending ?? reusableIdentity)) {
        return Promise.reject(new Error('These browser comments already belong to a pending or delivered message.'));
      }
      if (!pendingSend || pendingSend.fingerprint !== fingerprint) {
        pendingSend = {
          fingerprint,
          content,
          displayText,
          draft,
          attachments,
          composerAttachments,
          browserSubmission,
          contextDraft,
          delivery,
          ...(normalizedExpectedTurnId ? { expectedTurnId: normalizedExpectedTurnId } : {}),
          ...(appliedSettings?.model ? { model: appliedSettings.model } : {}),
          ...(appliedSettings?.agentKind ? { agentKind: appliedSettings.agentKind } : {}),
          ...(appliedSettings?.effort ? { effort: appliedSettings.effort } : {}),
          ...(appliedSettings && Object.prototype.hasOwnProperty.call(appliedSettings, 'serviceTier') ? { serviceTier: appliedSettings.serviceTier } : {}),
          ...(appliedSettings ? { permissionMode: appliedSettings.permissionMode } : {}),
          collaborationMode: requestedCollaborationMode,
          // provider 尚未接受的失败提交只调整服务档位时，沿用原幂等身份重试。
          idempotencyKey: reusableIdentity?.idempotencyKey ?? createId(),
          clientUserMessageId: reusableIdentity?.clientUserMessageId ?? createId(),
          startedAt: reusableIdentity?.startedAt ?? new Date().toISOString(),
        };
      }
      const envelope = pendingSend;
      if (state.transportState !== 'ready' || state.snapshot?.id !== options.conversationId || !realtimeSubscribed) {
        pendingSend = null;
        deferredSends = [...deferredSends, envelope];
        dispatch({
          type: 'send_started',
          clientUserMessageId: envelope.clientUserMessageId,
          durableClientUserMessageId: envelope.clientUserMessageId,
          draft: envelope.displayText,
          attachments: envelope.composerAttachments,
          submittedAttachments: envelope.attachments,
          browserSubmission: envelope.browserSubmission,
          contextDraft: envelope.contextDraft,
          browserComments: envelope.browserSubmission?.comments ?? [],
          delivery: envelope.delivery,
          previousConversationState: state.conversationState,
          startedAt: envelope.startedAt ?? new Date().toISOString(),
          queuedUntilHydrated: true,
        });
        persistDraft();
        if (state.transportState === 'ready' || state.transportState === 'failed' || state.transportState === 'disconnected') {
          void ensureRealtimeConnection().catch(() => undefined);
        }
        return Promise.resolve();
      }
      return submitEnvelope(envelope).then((acceptance) => {
        void flushDeferredSends();
        return acceptance;
      });
    },
    editQueuedSubmission(submissionId, content) {
      return runOperation(
        `queue:edit:${submissionId}:${JSON.stringify(content)}`,
        () => options.client.editNativeQueuedSubmission(options.projectId, options.conversationId, submissionId, content),
        (queue) => applyAuthoritativeQueue(queue),
      );
    },
    retryQueuedSubmission(submissionId) {
      return runOperation(
        `queue:retry:${submissionId}`,
        () => options.client.retryNativeQueuedSubmission(options.projectId, options.conversationId, submissionId),
        (queue) => applyAuthoritativeQueue(queue),
      );
    },
    rerouteQueuedSubmission(submissionId, settings) {
      return runOperation(
        `queue:reroute:${submissionId}:${JSON.stringify(settings)}`,
        () => options.client.rerouteNativeQueuedSubmission(options.projectId, options.conversationId, submissionId, settings),
        (queue) => applyAuthoritativeQueue(queue),
      );
    },
    deleteQueuedSubmission(submissionId) {
      const clientUserMessageId = state.queue?.submissions.find((submission) => submission.id === submissionId)?.clientUserMessageId;
      return runOperation(
        `queue:delete:${submissionId}`,
        () => options.client.deleteNativeQueuedSubmission(options.projectId, options.conversationId, submissionId),
        async (queue) => {
          dispatch({ type: 'queued_submission_deleted', submissionId, ...(clientUserMessageId ? { clientUserMessageId } : {}), queue });
          await recoverManualConfirmationQueue(queue);
        },
        false,
      );
    },
    reorderQueue(orderedSubmissionIds) {
      return runOperation(
        `queue:reorder:${JSON.stringify(orderedSubmissionIds)}`,
        () => options.client.reorderNativeQueue(options.projectId, options.conversationId, orderedSubmissionIds),
        (queue) => applyAuthoritativeQueue(queue),
      );
    },
    sendQueuedNow(submissionId) {
      const operation = `queue:send-now:${submissionId}`;
      if (activeOperation && activeOperation.key === operation) return activeOperation.promise as Promise<NativeOperationAcceptance>;
      if (activeOperation) return Promise.reject(new Error(`Session operation already in progress: ${activeOperation.key}`));

      const queuedSubmission = state.queue?.submissions.find((submission) => submission.id === submissionId);
      const pendingSubmission = queuedSubmission
        ? {
            ...queuedSubmission,
            status: 'steering',
            delivery: 'queue' as const,
            providerTurnId: null,
            updatedAt: new Date().toISOString(),
          }
        : null;
      if (pendingSubmission) {
        pendingSteeringSubmissions.set(submissionId, pendingSubmission);
        dispatch({
          type: 'queue_hydrated',
          queue: state.queue
            ? queueWithSubmission(state.queue, pendingSubmission)
            : {
                state: { type: 'active', turnId: state.activeTurnId ?? '', phase: 'prework' },
                waitReason: 'current_turn',
                submissions: [pendingSubmission],
              },
        });
      }

      const promise = runOperation(
        operation,
        () => options.client.sendNativeQueuedNow(options.projectId, options.conversationId, submissionId),
        (acceptance) => {
          if (!acceptance.submission) return;
          const accepted = acceptance.submission as unknown as Partial<NativeQueuedSubmission>;
          // acceptance 只代表 Provider 接受 steer RPC；消息真正进入当前轮次仍以 steering 事件为准。
          // 若服务端明确回队，则立即恢复正常队列投影，不能把它误画成当前轮次消息。
          if (pendingSubmission && (accepted.status === 'queued' || accepted.status === 'paused' || accepted.status === 'failed')) {
            pendingSteeringSubmissions.delete(submissionId);
            const requeued = {
              ...pendingSubmission,
              ...accepted,
              status: accepted.status,
              delivery: 'queue' as const,
              providerTurnId: accepted.providerTurnId ?? null,
            } as NativeQueuedSubmission;
            if (state.queue) dispatch({ type: 'queue_hydrated', queue: queueWithSubmission(state.queue, requeued) });
          }
        },
      );
      return promise.catch((error) => {
        const stillPending = pendingSteeringSubmissions.get(submissionId);
        if (!disposed && stillPending) {
          pendingSteeringSubmissions.delete(submissionId);
          const sessionError = toSessionError(error, true);
          const unconfirmed = {
            ...stillPending,
            status: 'paused',
            delivery: 'queue' as const,
            providerTurnId: null,
            pausedReason: 'recovery_required',
            error: {
              code: sessionError.code ?? 'ZEUS_NATIVE_STEER_OUTCOME_UNKNOWN',
              message: sessionError.message,
              recoveryRequired: true,
            },
            updatedAt: new Date().toISOString(),
          } as NativeQueuedSubmission;
          if (state.queue) dispatch({ type: 'queue_hydrated', queue: queueWithSubmission(state.queue, unconfirmed) });
          dispatch({
            type: 'steering_submission_failed',
            submissionId,
            ...(stillPending.clientUserMessageId ? { clientUserMessageId: stillPending.clientUserMessageId } : {}),
            error: sessionError,
          });
        }
        throw error;
      });
    },
    resumeQueue() {
      return runOperation(
        'queue:resume',
        () => options.client.resumeNativeQueue(options.projectId, options.conversationId),
        (queue) => applyAuthoritativeQueue(queue),
      );
    },
    recoverQueue() {
      return runOperation(
        'queue:recover',
        () => options.client.recoverNativeQueue(options.projectId, options.conversationId),
        (queue) => applyAuthoritativeQueue(queue),
        true,
      );
    },
    restoreArchivedConversation() {
      return runOperation(
        'provider-thread:restore',
        async () => {
          await options.client.restoreArchivedNativeConversation(options.projectId, options.conversationId);
          return loadConversationForHydration();
        },
        (snapshot) => applyAuthoritativeSnapshot(snapshot),
      );
    },
    interruptActiveTurn() {
      const turnId = state.activeTurnId;
      if (!turnId || state.startedTurnId !== turnId) return Promise.reject(new Error('A matching started turn is required before interrupt.'));
      const operation = `interrupt:${turnId}`;
      if (activeOperation) {
        if (activeOperation.key === operation) return activeOperation.promise as Promise<NativeOperationAcceptance>;
        return Promise.reject(new Error(`Session operation already in progress: ${activeOperation.key}`));
      }
      const previousConversationState = state.conversationState;
      dispatch({ type: 'interrupt_started', turnId });
      return runOperation(
        operation,
        () => options.client.interruptNativeTurn(options.projectId, options.conversationId, turnId),
        () => undefined,
      ).catch((error) => {
        dispatch({ type: 'interrupt_failed', previousConversationState, error: toSessionError(error, true) });
        throw error;
      });
    },
    respondToRequest(requestId, response) {
      return runOperation(
        `request:respond:${requestId}:${JSON.stringify(response)}`,
        () => options.client.respondToNativeRequest(options.projectId, options.conversationId, requestId, response),
        () => resumeEventsAfterRequestResponse(requestId),
      );
    },
    snoozeRequest(requestId) {
      return runOperation(
        `request:snooze:${requestId}`,
        () => options.client.snoozeNativeRequest(options.projectId, options.conversationId, requestId),
        ({ request }) =>
          dispatch({
            type: 'pending_requests_hydrated',
            requests: state.pendingRequests.map((candidate) => (candidate.id === request.id ? request : candidate)),
          }),
      );
    },
    respondToPlanImplementationRequest(requestId, input) {
      return runOperation(
        `plan-request:${requestId}:${JSON.stringify(input)}`,
        async () => {
          await options.client.respondToPlanImplementationRequest(options.projectId, options.conversationId, requestId, input);
          return loadConversationForHydration();
        },
        (snapshot) => applyAuthoritativeSnapshot(snapshot),
      ).then(() => undefined);
    },
    loadEarlierHistory: loadEarlierHistoryV2,
    loadTurnProcess: loadTurnProcessV2,
    loadTurnArtifacts: loadTurnArtifactsV2,
    loadV2Content(handle, offset) {
      const load = options.client.loadNativeConversationContentV2;
      if (!load || !state.snapshot?.snapshotV2) return Promise.reject(new Error('当前会话不支持 Snapshot V2 正文分页。'));
      return load(options.projectId, options.conversationId, handle, { ...(offset === undefined ? {} : { offset }), byteLimit: 64 * 1024 });
    },
    loadV2ToolResult(handle, offset) {
      const load = options.client.loadNativeConversationToolResult;
      if (!load || !state.snapshot?.snapshotV2) return Promise.reject(new Error('当前会话不支持完整工具结果分页。'));
      return load(options.projectId, options.conversationId, handle, { ...(offset === undefined ? {} : { offset }), limit: 16_384 });
    },
  };
  return controller;
}

export interface UseSessionControllerResult {
  state: NativeSessionState;
  controller: SessionController;
}

/**
 * 只管理 controller 生命周期，不订阅完整会话状态。正文、输入、队列等高频区域应在各自
 * 组件边界通过 useSessionControllerSelector 订阅所需 slice。
 */
export function useSessionControllerInstance(options: CreateSessionControllerOptions): SessionController {
  const controller = useMemo(
    () => createSessionController(options),
    [options.client, options.projectId, options.conversationId, options.enabled, options.initialCachedState, options.initialOptimisticState, options.storage, options.createId],
  );
  useEffect(() => {
    // 尚未启动的控制器没有连接资源可释放；启用时会按新状态构造可工作的实例。
    if (options.enabled === false) return;
    void controller.start().catch(() => undefined);
    return () => controller.dispose();
  }, [controller, options.enabled]);
  return controller;
}

/** useSyncExternalStore 的有缓存 selector；未命中的 store 更新不会触发该组件 commit。 */
export function useSessionControllerSelector<Selection>(controller: SessionController, selector: (state: NativeSessionState) => Selection, isEqual: (left: Selection, right: Selection) => boolean = Object.is): Selection {
  const selectionCache = useMemo<{ state: NativeSessionState | null; selection?: Selection }>(() => ({ state: null }), [controller, selector, isEqual]);
  const getSnapshot = useCallback(() => {
    const nextState = controller.getState();
    if (selectionCache.state === nextState && selectionCache.selection !== undefined) return selectionCache.selection;
    const nextSelection = selector(nextState);
    if (selectionCache.selection === undefined || !isEqual(selectionCache.selection, nextSelection)) selectionCache.selection = nextSelection;
    selectionCache.state = nextState;
    return selectionCache.selection;
  }, [controller, isEqual, selectionCache, selector]);
  return useSyncExternalStore(controller.subscribe, getSnapshot, getSnapshot);
}

const selectCompleteSessionState = (state: NativeSessionState): NativeSessionState => state;

export function useSessionController(options: CreateSessionControllerOptions): UseSessionControllerResult {
  const controller = useSessionControllerInstance(options);
  const state = useSessionControllerSelector(controller, selectCompleteSessionState);
  return { state, controller };
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : '按需读取失败。';
}

function browserStorage(): SessionDraftStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function readPersistedDraft(storage: SessionDraftStorage | undefined, key: string): PersistedDraft {
  const empty: PersistedDraft = { draft: '', attachments: [], contextDraft: structuredClone(emptyConversationContextDraft) };
  if (!storage) return empty;
  try {
    const raw = storage.getItem(key);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<PersistedDraft>;
    const attachments = Array.isArray(parsed.attachments) ? parsed.attachments.filter(isNativeAttachment) : [];
    const browserSubmission = isBrowserPreparedSubmission(parsed.browserSubmission) ? parsed.browserSubmission : null;
    const contextDraft = isConversationContextDraft(parsed.contextDraft) ? parsed.contextDraft : structuredClone(emptyConversationContextDraft);
    const pendingCandidate = isPendingSendEnvelope(parsed.pendingSend) ? parsed.pendingSend : undefined;
    const pending = pendingCandidate ? { ...pendingCandidate, collaborationMode: pendingCandidate.collaborationMode ?? 'default' } : undefined;
    const deferredSends = Array.isArray(parsed.deferredSends) ? parsed.deferredSends.filter(isPendingSendEnvelope).map((envelope) => ({ ...envelope, collaborationMode: envelope.collaborationMode ?? 'default' })) : [];
    const pendingBrowserCommentMarks = Array.isArray(parsed.pendingBrowserCommentMarks)
      ? mergePendingBrowserCommentMarks(parsed.pendingBrowserCommentMarks.map(normalizePendingBrowserCommentMark).filter((task): task is PendingBrowserCommentMark => task !== null))
      : [];
    const recoveredSubmissionIds = Array.isArray(parsed.recoveredSubmissionIds) ? parsed.recoveredSubmissionIds.filter((id): id is string => typeof id === 'string' && Boolean(id)) : [];
    const persistedDraft = typeof parsed.draft === 'string' ? parsed.draft : '';
    const restorePendingInput = pending && pending.deliveryState !== 'accepted' && !persistedDraft && attachments.length === 0 && !browserSubmission && !hasConversationContext(contextDraft);
    return {
      draft: restorePendingInput ? pending.draft : persistedDraft || (pending && parsed.draft === undefined ? pending.draft : ''),
      attachments: restorePendingInput ? pending.composerAttachments : attachments,
      browserSubmission: restorePendingInput ? pending.browserSubmission : browserSubmission,
      contextDraft: restorePendingInput ? pending.contextDraft : contextDraft,
      ...(pending ? { pendingSend: pending } : {}),
      ...(deferredSends.length > 0 ? { deferredSends } : {}),
      ...(pendingBrowserCommentMarks.length > 0 ? { pendingBrowserCommentMarks } : {}),
      ...(recoveredSubmissionIds.length > 0 ? { recoveredSubmissionIds } : {}),
    };
  } catch {
    return empty;
  }
}

function normalizePendingBrowserCommentMark(value: unknown): PendingBrowserCommentMark | null {
  if (typeof value !== 'object' || value === null) return null;
  const task = value as { id?: unknown; groups?: unknown };
  if (typeof task.id !== 'string' || !task.id || !Array.isArray(task.groups) || task.groups.length === 0) return null;
  const commentIdsByTab = new Map<string, Set<string>>();
  for (const valueGroup of task.groups) {
    if (typeof valueGroup !== 'object' || valueGroup === null) return null;
    const group = valueGroup as { tabId?: unknown; commentIds?: unknown };
    if (typeof group.tabId !== 'string' || !group.tabId || !Array.isArray(group.commentIds) || group.commentIds.length === 0) return null;
    if (!group.commentIds.every((commentId) => typeof commentId === 'string' && Boolean(commentId))) return null;
    const commentIds = commentIdsByTab.get(group.tabId) ?? new Set<string>();
    group.commentIds.forEach((commentId) => commentIds.add(commentId as string));
    commentIdsByTab.set(group.tabId, commentIds);
  }
  return {
    id: task.id,
    groups: [...commentIdsByTab].map(([tabId, commentIds]) => ({ tabId, commentIds: [...commentIds] })),
  };
}

function mergePendingBrowserCommentMarks(tasks: PendingBrowserCommentMark[]): PendingBrowserCommentMark[] {
  const groupsByTask = new Map<string, Map<string, Set<string>>>();
  for (const task of tasks) {
    const groupsByTab = groupsByTask.get(task.id) ?? new Map<string, Set<string>>();
    for (const group of task.groups) {
      const commentIds = groupsByTab.get(group.tabId) ?? new Set<string>();
      group.commentIds.forEach((commentId) => commentIds.add(commentId));
      groupsByTab.set(group.tabId, commentIds);
    }
    groupsByTask.set(task.id, groupsByTab);
  }
  return [...groupsByTask].map(([id, groupsByTab]) => ({
    id,
    groups: [...groupsByTab].map(([tabId, commentIds]) => ({ tabId, commentIds: [...commentIds] })),
  }));
}

function isPendingSendEnvelope(value: unknown): value is PendingSendEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const pending = value as Partial<PendingSendEnvelope>;
  return (
    typeof pending.fingerprint === 'string' &&
    typeof pending.content === 'string' &&
    typeof pending.displayText === 'string' &&
    typeof pending.draft === 'string' &&
    Array.isArray(pending.attachments) &&
    pending.attachments.every(isNativeAttachment) &&
    Array.isArray(pending.composerAttachments) &&
    pending.composerAttachments.every(isNativeAttachment) &&
    (pending.browserSubmission === null || isBrowserPreparedSubmission(pending.browserSubmission)) &&
    isConversationContextDraft(pending.contextDraft) &&
    (pending.delivery === 'queue' || pending.delivery === 'steer_now') &&
    (pending.expectedTurnId === undefined || typeof pending.expectedTurnId === 'string') &&
    (pending.model === undefined || typeof pending.model === 'string') &&
    (pending.effort === undefined || typeof pending.effort === 'string') &&
    (pending.serviceTier === undefined || pending.serviceTier === null || typeof pending.serviceTier === 'string') &&
    (pending.permissionMode === undefined || pending.permissionMode === 'read-only' || pending.permissionMode === 'auto' || pending.permissionMode === 'full-access') &&
    (pending.collaborationMode === undefined || pending.collaborationMode === 'default' || pending.collaborationMode === 'plan') &&
    typeof pending.idempotencyKey === 'string' &&
    typeof pending.clientUserMessageId === 'string' &&
    (pending.startedAt === undefined || typeof pending.startedAt === 'string') &&
    (pending.deliveryState === undefined || pending.deliveryState === 'pending' || pending.deliveryState === 'accepted' || pending.deliveryState === 'failed' || pending.deliveryState === 'uncertain') &&
    (pending.deliveryError === undefined || isNativeSessionError(pending.deliveryError)) &&
    (pending.acceptance === undefined || isNativeOperationAcceptance(pending.acceptance)) &&
    (pending.browserCommentsMarked === undefined || typeof pending.browserCommentsMarked === 'boolean') &&
    (pending.deliveryState !== 'accepted' || isNativeOperationAcceptance(pending.acceptance)) &&
    ((pending.deliveryState !== 'failed' && pending.deliveryState !== 'uncertain') || isNativeSessionError(pending.deliveryError))
  );
}

function isNativeSessionError(value: unknown): value is NativeSessionError {
  if (typeof value !== 'object' || value === null) return false;
  const error = value as Partial<NativeSessionError>;
  return (
    typeof error.message === 'string' &&
    (error.code === null || typeof error.code === 'string') &&
    typeof error.recoveryRequired === 'boolean' &&
    typeof error.retryable === 'boolean' &&
    (error.status === undefined || typeof error.status === 'number')
  );
}

function isBrowserPreparedSubmission(value: unknown): value is ZeusBrowserPreparedSubmission {
  if (typeof value !== 'object' || value === null) return false;
  const submission = value as Partial<ZeusBrowserPreparedSubmission>;
  return (
    typeof submission.tabId === 'string' &&
    Boolean(submission.tabId) &&
    typeof submission.content === 'string' &&
    Array.isArray(submission.commentIds) &&
    submission.commentIds.length > 0 &&
    submission.commentIds.every((id) => typeof id === 'string' && Boolean(id)) &&
    Array.isArray(submission.comments) &&
    submission.comments.length === submission.commentIds.length &&
    submission.comments.every((comment) => typeof comment === 'object' && comment !== null && typeof comment.id === 'string' && typeof comment.body === 'string') &&
    Array.isArray(submission.attachments) &&
    submission.attachments.every(isNativeAttachment)
  );
}

function isNativeOperationAcceptance(value: unknown): value is NativeOperationAcceptance {
  if (typeof value !== 'object' || value === null) return false;
  const acceptance = value as Partial<NativeOperationAcceptance>;
  return typeof acceptance.operation === 'object' && acceptance.operation !== null && typeof acceptance.conversation === 'object' && acceptance.conversation !== null && typeof acceptance.conversation.id === 'string';
}

function nativeOptimisticKey(state: NativeSessionState, clientUserMessageId: string): string {
  return [state.conversationId ?? 'pending-conversation', state.providerThreadId ?? 'pending-thread', `pending:${clientUserMessageId}`, clientUserMessageId].map((part) => encodeURIComponent(part)).join('/');
}

function hasNativeOptimisticItem(state: NativeSessionState, clientUserMessageId: string): boolean {
  const directItem = state.items[nativeOptimisticKey(state, clientUserMessageId)];
  return Boolean(directItem?.optimistic || Object.values(state.items).some((item) => item.optimistic && (item.clientUserMessageId === clientUserMessageId || item.durableClientUserMessageId === clientUserMessageId)));
}

function isNativeAttachment(value: unknown): value is NativeConversationAttachment {
  if (typeof value !== 'object' || value === null) return false;
  const attachment = value as { name?: unknown; mime?: unknown; size?: unknown; localPath?: unknown; uploadRef?: unknown };
  const paths = (typeof attachment.localPath === 'string' && attachment.localPath ? 1 : 0) + (typeof attachment.uploadRef === 'string' && attachment.uploadRef ? 1 : 0);
  return typeof attachment.name === 'string' && typeof attachment.mime === 'string' && Number.isSafeInteger(attachment.size) && Number(attachment.size) >= 0 && paths === 1;
}

function sendFingerprint(input: Omit<SendNativeMessageRequest, 'idempotencyKey' | 'clientUserMessageId'>): string {
  return JSON.stringify(input);
}

function sameAttachments(left: NativeConversationAttachment[], right: NativeConversationAttachment[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameBrowserSubmission(left: ZeusBrowserPreparedSubmission | null, right: ZeusBrowserPreparedSubmission | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameContextDraft(left: ConversationContextDraft, right: ConversationContextDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isConversationContextDraft(value: unknown): value is ConversationContextDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<ConversationContextDraft>;
  return Array.isArray(draft.responseAnnotations) && Array.isArray(draft.codeComments);
}

function mergeAttachments(left: NativeConversationAttachment[], right: NativeConversationAttachment[]): NativeConversationAttachment[] {
  const merged = new Map<string, NativeConversationAttachment>();
  for (const attachment of [...left, ...right]) {
    const key = 'localPath' in attachment ? `local:${attachment.localPath}` : `upload:${attachment.uploadRef}`;
    if (!merged.has(key)) merged.set(key, attachment);
  }
  return [...merged.values()];
}

function mergeRecoveredDraftText(current: string, recovered: string): string {
  const normalizedRecovered = recovered.trim();
  const normalizedCurrent = current.trim();
  if (
    !normalizedRecovered ||
    normalizedCurrent === normalizedRecovered ||
    normalizedCurrent.startsWith(`${normalizedRecovered}\n\n`) ||
    normalizedCurrent.endsWith(`\n\n${normalizedRecovered}`) ||
    normalizedCurrent.includes(`\n\n${normalizedRecovered}\n\n`)
  ) {
    return current;
  }
  return [normalizedRecovered, current].filter((part) => part.trim()).join('\n\n');
}

function mergeConversationContextDraft(left: ConversationContextDraft, right: ConversationContextDraft): ConversationContextDraft {
  const responseAnnotations = new Map(left.responseAnnotations.map((annotation) => [annotation.id, annotation]));
  const codeComments = new Map(left.codeComments.map((comment) => [comment.id, comment]));
  for (const annotation of right.responseAnnotations) if (!responseAnnotations.has(annotation.id)) responseAnnotations.set(annotation.id, annotation);
  for (const comment of right.codeComments) if (!codeComments.has(comment.id)) codeComments.set(comment.id, comment);
  return {
    responseAnnotations: [...responseAnnotations.values()],
    codeComments: [...codeComments.values()],
  };
}

function mergeBrowserSubmissions(current: ZeusBrowserPreparedSubmission | null, recovered: ZeusBrowserPreparedSubmission | null): ZeusBrowserPreparedSubmission | null {
  if (!recovered) return current;
  if (!current) return structuredClone(recovered);

  const comments = new Map(recovered.comments.map((comment) => [comment.id, comment]));
  for (const comment of current.comments) comments.set(comment.id, comment);
  const attachments = new Map(recovered.attachments.map((attachment) => [attachment.localPath, attachment]));
  for (const attachment of current.attachments) attachments.set(attachment.localPath, attachment);
  return {
    tabId: current.tabId,
    commentIds: [...new Set([...recovered.commentIds, ...current.commentIds])],
    content: mergeRecoveredDraftText(current.content, recovered.content),
    comments: [...comments.values()],
    attachments: [...attachments.values()],
  };
}

function browserSubmissionFromQueuedSubmission(submission: NativeQueuedSubmission): ZeusBrowserPreparedSubmission | null {
  const comments = submission.browserComments ?? [];
  const firstComment = comments[0];
  if (!firstComment) return null;
  const screenshotPaths = new Set(comments.map((comment) => comment.screenshotPath).filter((path): path is string => Boolean(path)));
  const attachments = (submission.attachments ?? []).flatMap((attachment) => {
    if (!('localPath' in attachment) || !attachment.localPath || attachment.mime !== 'image/png' || !screenshotPaths.has(attachment.localPath)) return [];
    return [{ name: attachment.name, mime: 'image/png' as const, size: attachment.size, localPath: attachment.localPath }];
  });
  return {
    tabId: firstComment.tabId,
    commentIds: comments.map((comment) => comment.id),
    content: submission.browserCommentContent?.trim() || serializeRecoveredBrowserComments(comments),
    comments: structuredClone(comments),
    attachments,
  };
}

function composerAttachmentsFromQueuedSubmission(submission: NativeQueuedSubmission): NativeConversationAttachment[] {
  const browserScreenshotPaths = new Set((submission.browserComments ?? []).map((comment) => comment.screenshotPath).filter((path): path is string => Boolean(path)));
  return (submission.attachments ?? []).filter((attachment) => !('localPath' in attachment) || !attachment.localPath || !browserScreenshotPaths.has(attachment.localPath));
}

function composerDraftFromQueuedSubmission(submission: NativeQueuedSubmission): string {
  if (typeof submission.composerDraft === 'string') return submission.composerDraft;
  const displayText = submission.content.trim();
  if (submission.browserComments?.length && /^Browser comments \(\d+\)$/u.test(displayText)) return '';
  if (submission.conversationContext && /^(?:Code comments|Response annotations) \(\d+\)$/u.test(displayText)) return '';
  return submission.content;
}

function serializeRecoveredBrowserComments(comments: NonNullable<NativeQueuedSubmission['browserComments']>): string {
  const sections = comments.map((comment) => {
    const anchor = comment.anchor;
    return [
      `## ${comment.number}. ${anchor.kind} comment`,
      `- Page: ${JSON.stringify(anchor.pageTitle || anchor.pageUrl)}`,
      `- URL: ${JSON.stringify(anchor.pageUrl)}`,
      ...(anchor.selector ? [`- Selector: ${JSON.stringify(anchor.selector)}`] : []),
      ...(anchor.textRange?.text ? [`- Selected text: ${JSON.stringify(anchor.textRange.text)}`] : []),
      `- Comment: ${JSON.stringify(comment.body)}`,
    ].join('\n');
  });
  return ['# Browser comments', '', 'Recovered from the durable Zeus conversation submission.', '', ...sections].join('\n\n');
}

function eventRequestId(event: NativeConversationEvent): string | null {
  const requestId = event.payload.requestId;
  return typeof requestId === 'string' && requestId.trim() ? requestId : null;
}

function eventCarriesRequestDetails(event: NativeConversationEvent, requestId: string): boolean {
  if (event.type !== 'conversation.request.created' || typeof event.payload.request !== 'object' || event.payload.request === null) return false;
  const request = event.payload.request as Partial<NativePendingRequest>;
  return request.id === requestId && typeof request.payload === 'object' && request.payload !== null && Object.keys(request.payload).length > 0;
}

function renderDeltaKey(event: NativeConversationEvent): string | null {
  if (event.type !== 'conversation.item.delta') return null;
  const { conversationId, generationId, threadId, turnId, itemId } = event.payload;
  if (!threadId || !turnId || !itemId) return null;
  return [conversationId, generationId, threadId, turnId, itemId].join(':');
}

function snapshotItemClientUserMessageId(item: { type: string; payload: Record<string, unknown> }): string | null {
  const normalizedType = item.type.toLocaleLowerCase().replace(/[\s_\-/]+/gu, '');
  if (normalizedType !== 'usermessage' && normalizedType !== 'user') return null;
  const clientId = item.payload.clientId ?? item.payload.clientUserMessageId;
  return typeof clientId === 'string' && clientId.trim() ? clientId : null;
}

function isManualConfirmationSubmission(submission: NativeQueuedSubmission): boolean {
  return (submission.status === 'queued' || submission.status === 'paused') && submission.pausedReason === 'user_confirmation' && !submission.providerTurnId;
}

function snapshotRequiresManualConfirmation(snapshot: NativeConversationSnapshot, clientUserMessageId: string): boolean {
  return snapshot.submissions.some((submission) => submission.clientUserMessageId === clientUserMessageId && isManualConfirmationSubmission(submission));
}

function nativeQueueSnapshotFrom(value: unknown): NativeQueueSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const queue = value as Partial<NativeQueueSnapshot>;
  if (!Array.isArray(queue.submissions) || !queue.state || typeof queue.state !== 'object') return null;
  return queue as NativeQueueSnapshot;
}

function toSessionError(error: unknown, retryable: boolean): NativeSessionError {
  if (typeof error === 'object' && error !== null) {
    const value = error as { message?: unknown; error?: unknown; status?: unknown };
    const code = typeof value.error === 'string' ? value.error : null;
    return {
      message: typeof value.message === 'string' ? value.message : String(error),
      code,
      recoveryRequired: false,
      retryable,
      ...(typeof value.status === 'number' ? { status: value.status } : {}),
    };
  }
  return { message: String(error), code: null, recoveryRequired: false, retryable };
}

function defaultCreateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
