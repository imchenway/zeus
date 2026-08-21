import type { CodexAppServerEvent, CodexAppServerManager } from '@zeus/ai-runtime';
import type { ConversationEventFlowControl } from './eventFlowControl.js';

const readableDeltaCoalesceMs = 40;
const maximumReadableDeltaBatchEvents = 2_048;
const maximumReadableDeltaBatchBytes = 1024 * 1024;
const maximumPendingReadableDeltaBytes = 4 * 1024 * 1024;
const maximumPendingReadableDeltaKeys = 256;

interface ReadableDeltaBatch {
  latest: CodexAppServerEvent;
  events: CodexAppServerEvent[];
  byteLength: number;
}

export interface CodexProviderEventFlowOptions {
  manager: CodexAppServerManager;
  flowControl?: ConversationEventFlowControl;
  isKnown(event: CodexAppServerEvent): boolean;
  handleEvent(event: CodexAppServerEvent, receiptEvents?: readonly CodexAppServerEvent[]): Promise<void>;
  handleEventError(event: CodexAppServerEvent, error: unknown, receiptEvents?: readonly CodexAppServerEvent[]): Promise<void>;
  handleDynamicToolCall(event: CodexAppServerEvent): Promise<void>;
}

export interface CodexProviderEventFlow {
  enqueueBarrier<T>(work: () => Promise<T>): Promise<T>;
  waitForIdle(): Promise<void>;
  beginHandoff(): Promise<void>;
}

/**
 * Codex Provider 事件的有界应用入口。
 *
 * 可读 delta 在小窗口内按稳定 item 身份合并，关键事件、恢复 barrier 与 delta
 * 共用同一串行链。非动态工具事件返回的 Promise 会传回 app-server transport，
 * 因而积压期间 stdout/WebSocket 会暂停读取；动态工具调用必须脱离该链，否则其
 * Provider RPC 响应会与被暂停的输入流互相等待。
 */
export function createCodexProviderEventFlow(options: CodexProviderEventFlowOptions): CodexProviderEventFlow {
  const pendingReadableDeltas = new Map<string, ReadableDeltaBatch>();
  let chain = Promise.resolve();
  let pendingReadableDeltaBytes = 0;
  let pendingReadableDeltaEventCount = 0;
  let pendingProviderWorkBytes = 0;
  let pendingProviderWorkEvents = 0;
  let readableDeltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let handedOff = false;

  const unsubscribe = options.manager.subscribe((event) => {
    if (event.method === 'item/tool/call') {
      void options.handleDynamicToolCall(event);
      return;
    }
    return enqueue(event);
  });

  function enqueue(event: CodexAppServerEvent): Promise<void> {
    const key = readableDeltaKey(event);
    const delta = readableDeltaText(event);
    if (key && delta !== null) {
      if (options.isKnown(event)) return chain;
      const deltaBytes = Buffer.byteLength(delta, 'utf8');
      let previous = pendingReadableDeltas.get(key);
      if (
        (previous && (previous.events.length >= maximumReadableDeltaBatchEvents || previous.byteLength + deltaBytes > maximumReadableDeltaBatchBytes)) ||
        pendingReadableDeltaBytes + deltaBytes > maximumPendingReadableDeltaBytes ||
        (!previous && pendingReadableDeltas.size >= maximumPendingReadableDeltaKeys)
      ) {
        flushReadableDeltas();
        previous = undefined;
      }
      if (previous) {
        previous.events.push(event);
        previous.latest = event;
        previous.byteLength += deltaBytes;
        pendingReadableDeltaBytes += deltaBytes;
        pendingReadableDeltaEventCount += 1;
        pendingReadableDeltas.delete(key);
        pendingReadableDeltas.set(key, previous);
        options.flowControl?.observeCoalescedProcessEvent();
      } else {
        pendingReadableDeltas.set(key, { latest: event, events: [event], byteLength: deltaBytes });
        pendingReadableDeltaBytes += deltaBytes;
        pendingReadableDeltaEventCount += 1;
      }
      observeHighWater();
      scheduleReadableDeltaFlush();
      return chain;
    }
    flushReadableDeltas();
    const finish = beginProviderWork(providerEventByteLength(event), 1);
    chain = chain
      .then(async () => {
        try {
          await options.handleEvent(event);
        } catch (error) {
          await options.handleEventError(event, error);
        } finally {
          finish();
        }
      })
      .catch(() => undefined);
    return chain;
  }

  function scheduleReadableDeltaFlush(): void {
    if (readableDeltaFlushTimer) return;
    readableDeltaFlushTimer = setTimeout(() => {
      readableDeltaFlushTimer = null;
      flushReadableDeltas();
    }, readableDeltaCoalesceMs);
  }

  function flushReadableDeltas(): void {
    if (readableDeltaFlushTimer) clearTimeout(readableDeltaFlushTimer);
    readableDeltaFlushTimer = null;
    if (pendingReadableDeltas.size === 0) return;
    const batches = [...pendingReadableDeltas.values()];
    pendingReadableDeltas.clear();
    pendingReadableDeltaBytes = 0;
    pendingReadableDeltaEventCount = 0;
    const finish = beginProviderWork(
      batches.reduce((total, batch) => total + batch.byteLength, 0),
      batches.reduce((total, batch) => total + batch.events.length, 0),
    );
    chain = chain
      .then(async () => {
        try {
          for (const batch of batches) {
            const latest = batch.latest;
            const latestParams = isRecord(latest.params) ? latest.params : {};
            const mergedEvent: CodexAppServerEvent = {
              ...latest,
              params: { ...latestParams, delta: batch.events.map((event) => readableDeltaText(event) ?? '').join('') },
            };
            try {
              await options.handleEvent(mergedEvent, batch.events);
            } catch (error) {
              await options.handleEventError(mergedEvent, error, batch.events);
            }
          }
        } finally {
          finish();
        }
      })
      .catch(() => undefined);
  }

  function beginProviderWork(byteLength: number, eventCount: number): () => void {
    pendingProviderWorkBytes += byteLength;
    pendingProviderWorkEvents += eventCount;
    observeHighWater();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      pendingProviderWorkBytes = Math.max(0, pendingProviderWorkBytes - byteLength);
      pendingProviderWorkEvents = Math.max(0, pendingProviderWorkEvents - eventCount);
    };
  }

  function observeHighWater(): void {
    options.flowControl?.observeHighWater('provider', pendingProviderWorkBytes + pendingReadableDeltaBytes, pendingProviderWorkEvents + pendingReadableDeltaEventCount);
  }

  return {
    enqueueBarrier<T>(work: () => Promise<T>): Promise<T> {
      flushReadableDeltas();
      const result = chain.then(work);
      // 恢复补偿和实时事件必须共用顺序，且一次 barrier 失败不能毒化后续事件。
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    waitForIdle(): Promise<void> {
      return chain;
    },
    beginHandoff(): Promise<void> {
      if (!handedOff) {
        handedOff = true;
        unsubscribe();
        flushReadableDeltas();
      }
      return chain;
    },
  };
}

export function isCodexReadableItemTextDeltaEvent(method: string): boolean {
  return method === 'item/agentMessage/delta' || method === 'item/plan/delta';
}

export function codexProviderEventIdentity(event: CodexAppServerEvent): string {
  const params = isRecord(event.params) ? event.params : {};
  return [event.generationId, event.sequence, event.method, params.threadId ?? '', providerTurnIdFrom(params) ?? '', providerItemIdFrom(params) ?? '', event.requestId ?? ''].join('|');
}

function readableDeltaKey(event: CodexAppServerEvent): string | null {
  if (!isCodexReadableItemTextDeltaEvent(event.method) || !isRecord(event.params)) return null;
  const threadId = typeof event.params.threadId === 'string' ? event.params.threadId : null;
  const turnId = providerTurnIdFrom(event.params);
  const itemId = providerItemIdFrom(event.params);
  if (!threadId || !turnId || !itemId) return null;
  return [event.generationId, threadId, turnId, itemId, event.method].join(':');
}

function readableDeltaText(event: CodexAppServerEvent): string | null {
  return isRecord(event.params) && typeof event.params.delta === 'string' ? event.params.delta : null;
}

function providerEventByteLength(event: CodexAppServerEvent): number {
  return Buffer.byteLength(JSON.stringify({ generationId: event.generationId, sequence: event.sequence, method: event.method, params: event.params, requestId: event.requestId ?? null }), 'utf8');
}

function providerTurnIdFrom(params: Record<string, unknown>): string | null {
  const turn = isRecord(params.turn) ? params.turn : {};
  return typeof params.turnId === 'string' ? params.turnId : typeof turn.id === 'string' ? turn.id : null;
}

function providerItemIdFrom(params: Record<string, unknown>): string | null {
  const item = isRecord(params.item) ? params.item : {};
  return typeof params.itemId === 'string' ? params.itemId : typeof item.id === 'string' ? item.id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
