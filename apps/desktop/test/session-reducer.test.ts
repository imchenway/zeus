import { describe, expect, it, vi } from 'vitest';
import { createInitialSessionState, nativeSessionItemKey, sessionReducer } from '../src/renderer/session/sessionReducer.js';
import { selectSessionComposerAction, selectSessionStatusSemantics } from '../src/renderer/session/sessionSelectors.js';
import { createSessionController, type SessionControllerClient, type SessionDraftStorage } from '../src/renderer/session/useSessionController.js';
import type { NativeConversationAttachment, NativeConversationEvent, NativeConversationSnapshot, NativeOperationAcceptance, NativePendingRequest, NativeQueueSnapshot } from '../src/renderer/session/sessionTypes.js';

function snapshot(overrides: Partial<NativeConversationSnapshot> = {}): NativeConversationSnapshot {
  return {
    id: 'conversation-1',
    projectId: 'project-1',
    taskId: 'task-1',
    sessionId: null,
    title: 'Native thread',
    summary: null,
    status: 'running',
    transportKind: 'codex_native',
    providerId: 'codex',
    providerThreadId: 'thread-1',
    providerModel: 'gpt-5.4',
    providerState: 'active',
    provider: { id: 'codex', threadId: 'thread-1', model: 'gpt-5.4', state: 'active' },
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    archived: false,
    messages: [],
    turns: [
      {
        id: 'local-turn-1',
        providerTurnId: 'turn-1',
        submissionId: 'submission-1',
        status: 'running',
        startedAt: '2026-07-13T00:00:00.000Z',
        completedAt: null,
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
      },
    ],
    items: [],
    submissions: [],
    queue: { state: { type: 'active', turnId: 'turn-1', phase: 'prework' }, submissions: [] },
    requests: [],
    ...overrides,
  };
}

function event(type: NativeConversationEvent['type'], sequence: number, payload: Record<string, unknown>, id = `${type}-${sequence}`): NativeConversationEvent {
  return {
    id,
    type,
    createdAt: `2026-07-13T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    payload: {
      projectId: 'project-1',
      conversationId: 'conversation-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      generationId: 'generation-1',
      sequence,
      ...payload,
    },
  } as NativeConversationEvent;
}

function pendingRequest() {
  return {
    id: 'request-1',
    conversationId: 'conversation-1',
    turnId: 'local-turn-1',
    itemId: null,
    generationId: 'generation-1',
    type: 'command',
    status: 'pending',
    payload: { command: 'pwd' },
    response: null,
    containsSecret: false,
    expiresAt: null,
    createdAt: '2026-07-13T00:00:00.000Z',
    resolvedAt: null,
  } as const;
}

class TestEventSocket {
  readyState = 0;
  close = vi.fn(() => this.emit('close'));
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const entries = this.listeners.get(type) ?? new Set();
    entries.add(listener);
    this.listeners.set(type, entries);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: 'open' | 'close' | 'error'): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

function reduceEvents(events: NativeConversationEvent[], initial = sessionReducer(createInitialSessionState(), { type: 'snapshot_hydrated', snapshot: snapshot() })) {
  return events.reduce((state, current) => sessionReducer(state, { type: 'event_received', event: current }), initial);
}

describe('native session reducer', () => {
  it('keeps the optimistic user item until provider confirmation and renders one durable user message after snapshot convergence', () => {
    let state = sessionReducer(createInitialSessionState(), { type: 'snapshot_hydrated', snapshot: snapshot() });
    state = sessionReducer(state, {
      type: 'send_started',
      clientUserMessageId: 'client-user-1',
      durableClientUserMessageId: 'client-user-1',
      draft: 'optimistic prompt',
      attachments: [],
      delivery: 'queue',
      previousConversationState: 'idle',
    });
    state = sessionReducer(state, {
      type: 'snapshot_hydrated',
      snapshot: snapshot({
        submissions: [
          {
            id: 'submission-user-1',
            conversationId: 'conversation-1',
            content: 'optimistic prompt',
            status: 'active',
            delivery: 'queue',
            attachments: [],
            expectedTurnId: null,
            clientUserMessageId: 'client-user-1',
            position: null,
            providerTurnId: 'turn-1',
            pausedReason: null,
            createdAt: '2026-07-13T00:00:00.000Z',
            updatedAt: '2026-07-13T00:00:01.000Z',
          },
        ],
      }),
    });
    expect(state.itemOrder.map((key) => state.items[key]).filter((item) => item?.type === 'userMessage')).toEqual([expect.objectContaining({ optimistic: true, clientUserMessageId: 'client-user-1' })]);

    state = sessionReducer(state, {
      type: 'event_received',
      event: event('conversation.item.started', 2, {
        itemId: 'provider-user-item-1',
        itemType: 'userMessage',
        itemPayload: { id: 'provider-user-item-1', type: 'userMessage', clientId: 'client-user-1', content: [{ type: 'text', text: 'provider canonical prompt' }] },
        textContent: 'provider canonical prompt',
        status: 'in_progress',
        phase: 'prework',
      }),
    });
    expect(state.itemOrder.map((key) => state.items[key]).filter((item) => item?.type === 'userMessage')).toEqual([
      expect.objectContaining({ itemId: 'provider-user-item-1', text: 'provider canonical prompt', optimistic: false, clientUserMessageId: 'client-user-1' }),
    ]);

    state = sessionReducer(state, {
      type: 'snapshot_hydrated',
      snapshot: snapshot({
        messages: [
          {
            id: 'durable-user-message-1',
            conversationId: 'conversation-1',
            role: 'user',
            content: 'provider canonical prompt',
            source: 'codex_native',
            metadata: { clientUserMessageId: 'client-user-1' },
            createdAt: '2026-07-13T00:00:02.000Z',
          },
        ],
        items: [
          {
            id: 'local-provider-user-item-1',
            turnId: 'local-turn-1',
            providerItemId: 'provider-user-item-1',
            type: 'userMessage',
            status: 'completed',
            phase: 'prework',
            text: 'provider canonical prompt',
            payload: { id: 'provider-user-item-1', type: 'userMessage', clientId: 'client-user-1' },
            startedAt: '2026-07-13T00:00:02.000Z',
            completedAt: '2026-07-13T00:00:02.000Z',
            updatedAt: '2026-07-13T00:00:02.000Z',
          },
        ],
      }),
    });
    expect(state.itemOrder.map((key) => state.items[key]).filter((item) => item?.type === 'userMessage')).toEqual([
      expect.objectContaining({ localItemId: 'durable-user-message-1', text: 'provider canonical prompt', optimistic: false, clientUserMessageId: 'client-user-1' }),
    ]);
  });

  it('deduplicates by event id and generation sequence while completed payload remains authoritative over cumulative deltas', () => {
    const started = event('conversation.item.started', 1, {
      itemId: 'item-1',
      itemType: 'commandExecution',
      itemPayload: { command: 'pnpm test', status: 'in_progress' },
      status: 'in_progress',
      phase: 'prework',
    });
    const firstPartial = event('conversation.item.delta', 2, {
      itemId: 'item-1',
      itemType: 'commandExecution',
      itemPayload: { command: 'pnpm test', status: 'in_progress', output: 'hel' },
      textContent: 'hel',
      status: 'in_progress',
      phase: 'prework',
    });
    const cumulativePartial = event('conversation.item.delta', 3, {
      itemId: 'item-1',
      itemType: 'commandExecution',
      itemPayload: { command: 'pnpm test', status: 'in_progress', output: 'hello' },
      textContent: 'hello',
      status: 'in_progress',
      phase: 'prework',
    });
    const completed = event('conversation.item.completed', 4, {
      itemId: 'item-1',
      itemType: 'commandExecution',
      itemPayload: { command: 'pnpm test', status: 'completed', output: 'Hello, authoritative final.', exitCode: 0 },
      textContent: 'Hello, authoritative final.',
      status: 'completed',
      phase: 'final_answer',
    });
    const staleDifferentId = event('conversation.item.delta', 3, { itemId: 'item-1', textContent: 'hellohello', status: 'in_progress', phase: 'prework' }, 'stale-different-id');

    const state = reduceEvents([started, firstPartial, firstPartial, cumulativePartial, completed, staleDifferentId]);
    const key = nativeSessionItemKey('conversation-1', 'thread-1', 'turn-1', 'item-1');

    expect(state.itemOrder).toEqual([key]);
    expect(state.items[key]).toMatchObject({
      type: 'commandExecution',
      text: 'Hello, authoritative final.',
      status: 'completed',
      phase: 'final_answer',
      payload: { command: 'pnpm test', status: 'completed', output: 'Hello, authoritative final.', exitCode: 0 },
    });
    expect(state.conversationState).toBe('active_final_answer');
    expect(state.seenEventIds).toEqual(expect.objectContaining({ [started.id]: true, [completed.id]: true }));
  });

  it('isolates conversation, thread, turn, and item identity while allowing multiple turns on one provider thread', () => {
    const base = sessionReducer(createInitialSessionState(), {
      type: 'snapshot_hydrated',
      snapshot: snapshot({
        turns: [...snapshot().turns, { ...snapshot().turns[0], id: 'local-turn-2', providerTurnId: 'turn-2', submissionId: 'submission-2' }],
      }),
    });
    const first = event('conversation.item.started', 1, { itemId: 'same-item' });
    const second = event('conversation.item.started', 2, { itemId: 'same-item', turnId: 'turn-2' });
    const wrongThread = event('conversation.item.started', 3, { itemId: 'wrong', threadId: 'thread-other' });
    const wrongConversation = event('conversation.item.started', 4, { itemId: 'wrong', conversationId: 'conversation-other' });
    const state = reduceEvents([first, second, wrongThread, wrongConversation], base);

    expect(state.itemOrder).toEqual([nativeSessionItemKey('conversation-1', 'thread-1', 'turn-1', 'same-item'), nativeSessionItemKey('conversation-1', 'thread-1', 'turn-2', 'same-item')]);
    const activeSecond = sessionReducer(state, { type: 'event_received', event: event('conversation.turn.started', 5, { turnId: 'turn-2' }) });
    const staleCompletion = sessionReducer(activeSecond, { type: 'event_received', event: event('conversation.turn.completed', 6, { turnId: 'turn-1', status: 'completed' }) });
    const completed = sessionReducer(staleCompletion, { type: 'event_received', event: event('conversation.turn.completed', 7, { turnId: 'turn-2', status: 'completed' }) });
    expect(staleCompletion.conversationState).toBe('active_prework');
    expect(completed.conversationState).toBe('native_idle');
  });

  it('updates provider snapshots without mutating transcript buffers or losing the active turn', () => {
    const initial = reduceEvents([event('conversation.item.started', 1, { itemId: 'item-1' })]);
    const items = initial.items;
    const transcriptRevision = initial.transcriptRevision;
    const state = reduceEvents(
      [
        event('conversation.settings.changed', 2, { model: 'gpt-5.4', effort: 'high' }),
        event('conversation.tokenUsage.changed', 3, { inputTokens: 5, outputTokens: 3, totalTokens: 8 }),
        event('conversation.rateLimits.changed', 4, { value: { primary: { remaining: 50 } } }),
        event('conversation.mcpStartup.changed', 5, { value: { filesystem: 'ready' } }),
      ],
      initial,
    );

    expect(state.items).toBe(items);
    expect(state.transcriptRevision).toBe(transcriptRevision);
    expect(state.conversationState).toBe('active_prework');
    expect(state.providerSettings).toMatchObject({ model: 'gpt-5.4', effort: 'high' });
    expect(state.tokenUsage).toMatchObject({ totalTokens: 8 });
    expect(state.rateLimits?.value).toEqual({ primary: { remaining: 50 } });
    expect(state.mcpStartup?.value).toEqual({ filesystem: 'ready' });
    expect(selectSessionStatusSemantics(state)).toEqual({ role: 'status', ariaLive: 'polite', label: 'Codex 正在处理' });
  });

  it('keeps terminal turns monotonic when a late item event follows turn completion', () => {
    const active = reduceEvents([event('conversation.item.delta', 1, { itemId: 'item-1', textContent: 'working' })]);
    const completed = sessionReducer(active, { type: 'event_received', event: event('conversation.turn.completed', 2, { status: 'completed' }) });
    const late = sessionReducer(completed, {
      type: 'event_received',
      event: event('conversation.item.completed', 3, { itemId: 'item-1', textContent: 'final text', status: 'completed', phase: 'final_answer' }),
    });

    expect(late.conversationState).toBe('native_idle');
    expect(late.activeTurnId).toBeNull();
    expect(late.items[nativeSessionItemKey('conversation-1', 'thread-1', 'turn-1', 'item-1')]).toMatchObject({ text: 'final text', status: 'completed' });

    const staleDelta = sessionReducer(late, {
      type: 'event_received',
      event: event('conversation.item.delta', 4, { itemId: 'item-1', textContent: 'downgraded', status: 'in_progress', phase: 'prework' }),
    });
    expect(staleDelta.items[nativeSessionItemKey('conversation-1', 'thread-1', 'turn-1', 'item-1')]).toMatchObject({ text: 'final text', status: 'completed', phase: 'final_answer' });
    expect(staleDelta.conversationState).toBe('native_idle');
  });

  it('treats request projections as authoritative and normalizes local request ids to provider ids', () => {
    const hydrated = sessionReducer(createInitialSessionState(), {
      type: 'snapshot_hydrated',
      snapshot: snapshot({
        items: [
          {
            id: 'local-item-1',
            turnId: 'local-turn-1',
            providerItemId: 'provider-item-1',
            type: 'commandExecution',
            status: 'in_progress',
            phase: 'prework',
            text: '',
            payload: {},
            startedAt: null,
            completedAt: null,
            updatedAt: '2026-07-13T00:00:00.000Z',
          },
        ],
        requests: [
          {
            id: 'request-1',
            conversationId: 'conversation-1',
            turnId: 'local-turn-1',
            itemId: 'local-item-1',
            generationId: 'generation-1',
            type: 'command',
            status: 'pending',
            payload: { command: 'pwd' },
            response: null,
            containsSecret: false,
            expiresAt: null,
            createdAt: '2026-07-13T00:00:00.000Z',
            resolvedAt: null,
          },
        ],
      }),
    });
    expect(hydrated.pendingRequests[0]).toMatchObject({ turnId: 'turn-1', itemId: 'provider-item-1' });

    const cleared = sessionReducer(hydrated, { type: 'pending_requests_hydrated', requests: [] });
    expect(cleared.pendingRequests).toEqual([]);
    expect(cleared.conversationState).toBe('active_prework');
  });

  it('preserves typed recovery errors without advertising an unsafe generic retry', () => {
    const state = reduceEvents([
      event('conversation.native.error', 1, {
        error: 'ZEUS_CODEX_REQUEST_GENERATION_STALE',
        message: 'retired generation',
        recoveryRequired: true,
      }),
    ]);
    expect(state.error).toMatchObject({ code: 'ZEUS_CODEX_REQUEST_GENERATION_STALE', message: 'retired generation', recoveryRequired: true, retryable: false });
    expect(selectSessionStatusSemantics(state)).toEqual({ role: 'alert', ariaLive: 'assertive', label: 'retired generation' });
    expect(selectSessionComposerAction(state)).toBe('disabled');
  });

  it('atomically changes provider thread identity and rejects stale events from the retired thread', () => {
    const oldItem = event('conversation.item.started', 1, {
      itemId: 'old-item',
      itemType: 'reasoning',
      itemPayload: { summary: 'old thread' },
    });
    const transportChanged = event('conversation.transport.changed', 2, {
      threadId: 'thread-2',
      providerThreadId: 'thread-2',
      providerState: 'ready',
      transportKind: 'codex_native',
    });
    const threadChanged = event('conversation.thread.changed', 3, {
      threadId: 'thread-2',
      providerThreadId: 'thread-2',
      providerState: 'active',
    });
    const newItem = event('conversation.item.started', 4, {
      threadId: 'thread-2',
      turnId: 'turn-2',
      itemId: 'new-item',
      itemType: 'commandExecution',
      itemPayload: { command: 'pwd' },
    });
    const staleOldThread = event('conversation.item.delta', 5, {
      threadId: 'thread-1',
      itemId: 'stale-old-item',
      itemType: 'reasoning',
      itemPayload: { summary: 'stale' },
      textContent: 'must not appear',
    });

    const state = reduceEvents([oldItem, transportChanged, threadChanged, newItem, staleOldThread]);
    expect(state.providerThreadId).toBe('thread-2');
    expect(state.snapshot).toMatchObject({
      providerThreadId: 'thread-2',
      providerState: 'active',
      provider: { threadId: 'thread-2', state: 'active' },
    });
    expect(state.items[nativeSessionItemKey('conversation-1', 'thread-2', 'turn-2', 'new-item')]).toMatchObject({ type: 'commandExecution', payload: { command: 'pwd' } });
    expect(state.items[nativeSessionItemKey('conversation-1', 'thread-1', 'turn-1', 'stale-old-item')]).toBeUndefined();
    expect(state.activeTurnId).toBe('turn-2');
  });
});

describe('native session controller', () => {
  it('persists permission changes only while idle and hydrates the returned authoritative snapshot', async () => {
    let eventListener: ((value: NativeConversationEvent) => void) | undefined;
    const idleSnapshot = snapshot({
      permissionMode: 'auto',
      providerState: 'ready',
      provider: { id: 'codex', threadId: 'thread-1', model: 'gpt-5.4', state: 'ready' },
      turns: [],
      queue: { state: { type: 'idle' }, submissions: [] },
    });
    const updatedSnapshot = { ...idleSnapshot, permissionMode: 'full-access' as const };
    const client = {
      loadNativeConversation: vi.fn(async () => idleSnapshot),
      connectEvents: vi.fn((listener: (value: NativeConversationEvent) => void) => {
        eventListener = listener;
        return { close: vi.fn() } as unknown as WebSocket;
      }),
      updateNativePermissionMode: vi.fn(async () => updatedSnapshot),
      sendNativeMessage: vi.fn(),
    } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });
    await controller.start();

    await expect(controller.setPermissionMode('full-access')).resolves.toMatchObject({ permissionMode: 'full-access' });
    expect(client.updateNativePermissionMode).toHaveBeenCalledWith('project-1', 'conversation-1', 'full-access');
    expect(controller.getState().snapshot).toMatchObject({ permissionMode: 'full-access' });

    eventListener?.(event('conversation.turn.started', 30, { turnId: 'turn-active' }));
    expect(controller.getState().conversationState).toBe('active_prework');
    await expect(controller.setPermissionMode('read-only')).rejects.toThrow('only while the conversation is idle');
    expect(client.updateNativePermissionMode).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('connects before hydration, applies buffered cumulative events once, and refreshes only request details', async () => {
    let eventListener: ((value: NativeConversationEvent) => void) | undefined;
    const loadSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ requests: [pendingRequest()] }));
    const connectEvents = vi.fn((listener: (value: NativeConversationEvent) => void) => {
      eventListener = listener;
      return { close: vi.fn() } as unknown as WebSocket;
    });
    const client = {
      loadNativeConversation: loadSnapshot,
      connectEvents,
      sendNativeMessage: vi.fn(),
    } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });

    const starting = controller.start();
    expect(connectEvents).toHaveBeenCalledTimes(1);
    expect(loadSnapshot).not.toHaveBeenCalled();
    eventListener?.(event('conversation.item.delta', 11, { itemId: 'item-buffered', textContent: 'buffered' }, 'buffered-event'));
    await starting;

    expect(controller.getState().transportState).toBe('ready');
    expect(controller.getState().items[nativeSessionItemKey('conversation-1', 'thread-1', 'turn-1', 'item-buffered')]?.text).toBe('buffered');
    eventListener?.(event('conversation.settings.changed', 12, { model: 'gpt-5.4', effort: 'medium' }));
    eventListener?.(event('conversation.tokenUsage.changed', 13, { inputTokens: 1, outputTokens: 2, totalTokens: 3 }));
    eventListener?.(event('conversation.mcpStartup.changed', 14, { value: { filesystem: 'ready' } }));
    await Promise.resolve();
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    eventListener?.(event('conversation.request.created', 15, { requestId: 'request-1', requestKind: 'command' }));
    await vi.waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));
    expect(controller.getState().conversationState).toBe('waiting_approval');
    controller.dispose();
  });

  it('lets thread identity control events switch scope before accepting new-thread items', async () => {
    let eventListener: ((value: NativeConversationEvent) => void) | undefined;
    const client = {
      loadNativeConversation: vi.fn(async () => snapshot()),
      connectEvents: vi.fn((listener: (value: NativeConversationEvent) => void) => {
        eventListener = listener;
        return { close: vi.fn() } as unknown as WebSocket;
      }),
      sendNativeMessage: vi.fn(),
    } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });
    await controller.start();

    eventListener?.(
      event('conversation.thread.changed', 20, {
        threadId: 'thread-2',
        providerThreadId: 'thread-2',
        providerState: 'active',
      }),
    );
    eventListener?.(
      event('conversation.item.started', 21, {
        threadId: 'thread-2',
        turnId: 'turn-2',
        itemId: 'new-thread-item',
        itemType: 'agentMessage',
        itemPayload: { text: 'new thread answer' },
      }),
    );
    eventListener?.(
      event('conversation.item.delta', 22, {
        threadId: 'thread-1',
        itemId: 'retired-thread-item',
        itemType: 'agentMessage',
        itemPayload: { text: 'stale' },
        textContent: 'stale',
      }),
    );

    expect(controller.getState().providerThreadId).toBe('thread-2');
    expect(controller.getState().items[nativeSessionItemKey('conversation-1', 'thread-2', 'turn-2', 'new-thread-item')]).toBeDefined();
    expect(controller.getState().items[nativeSessionItemKey('conversation-1', 'thread-1', 'turn-1', 'retired-thread-item')]).toBeUndefined();
    controller.dispose();
  });

  it('normalizes a new-turn request from the refreshed detail maps without rebuilding the live transcript', async () => {
    let eventListener: ((value: NativeConversationEvent) => void) | undefined;
    let resolveRequestDetail!: (value: NativeConversationSnapshot) => void;
    const requestDetail = new Promise<NativeConversationSnapshot>((resolve) => {
      resolveRequestDetail = resolve;
    });
    const loadNativeConversation = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockImplementationOnce(() => requestDetail);
    const client = {
      loadNativeConversation,
      connectEvents: vi.fn((listener: (value: NativeConversationEvent) => void) => {
        eventListener = listener;
        return { close: vi.fn() } as unknown as WebSocket;
      }),
      sendNativeMessage: vi.fn(),
    } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });
    await controller.start();
    eventListener?.(event('conversation.item.delta', 20, { itemId: 'live-item', itemType: 'reasoning', itemPayload: { summary: 'live' }, textContent: 'live text' }, 'live-item-event'));
    const liveItems = controller.getState().items;
    const liveOrder = controller.getState().itemOrder;
    const liveRevision = controller.getState().transcriptRevision;

    eventListener?.(event('conversation.request.created', 21, { turnId: 'provider-turn-2', requestId: 'request-turn-2', requestKind: 'command' }, 'request-turn-2-event'));
    await vi.waitFor(() => expect(loadNativeConversation).toHaveBeenCalledTimes(2));
    resolveRequestDetail(
      snapshot({
        turns: [...snapshot().turns, { ...snapshot().turns[0], id: 'local-turn-2', providerTurnId: 'provider-turn-2', submissionId: 'submission-2' }],
        items: [
          {
            id: 'local-item-2',
            turnId: 'local-turn-2',
            providerItemId: 'provider-item-2',
            type: 'commandExecution',
            status: 'in_progress',
            phase: 'prework',
            text: '',
            payload: { command: 'pwd' },
            startedAt: null,
            completedAt: null,
            updatedAt: '2026-07-13T00:00:21.000Z',
          },
        ],
        requests: [
          {
            ...pendingRequest(),
            id: 'request-turn-2',
            turnId: 'local-turn-2',
            itemId: 'local-item-2',
          },
        ],
      }),
    );

    await vi.waitFor(() => expect(controller.getState().pendingRequests).toEqual([expect.objectContaining({ id: 'request-turn-2', turnId: 'provider-turn-2', itemId: 'provider-item-2' })]));
    expect(controller.getState().items).toBe(liveItems);
    expect(controller.getState().itemOrder).toBe(liveOrder);
    expect(controller.getState().transcriptRevision).toBe(liveRevision);
    controller.dispose();
  });

  it('keeps a resolved request tombstoned when an older request-detail refresh and created event arrive late', async () => {
    let eventListener: ((value: NativeConversationEvent) => void) | undefined;
    let resolveRequestDetail!: (value: NativeConversationSnapshot) => void;
    const requestDetail = new Promise<NativeConversationSnapshot>((resolve) => {
      resolveRequestDetail = resolve;
    });
    const loadNativeConversation = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockImplementationOnce(() => requestDetail)
      .mockResolvedValue(snapshot({ requests: [pendingRequest()] }));
    const client = {
      loadNativeConversation,
      connectEvents: vi.fn((listener: (value: NativeConversationEvent) => void) => {
        eventListener = listener;
        return { close: vi.fn() } as unknown as WebSocket;
      }),
      sendNativeMessage: vi.fn(),
    } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });
    const pendingProjections: string[][] = [];
    controller.subscribe(() => pendingProjections.push(controller.getState().pendingRequests.map((request) => request.id)));
    await controller.start();

    eventListener?.(event('conversation.request.created', 20, { requestId: 'request-1', requestKind: 'command' }, 'request-created'));
    await vi.waitFor(() => expect(loadNativeConversation).toHaveBeenCalledTimes(2));
    expect(controller.getState().pendingRequests).toEqual([expect.objectContaining({ id: 'request-1' })]);

    eventListener?.(event('conversation.request.resolved', 21, { requestId: 'request-1' }, 'request-resolved'));
    expect(controller.getState().pendingRequests).toEqual([]);
    expect(selectSessionComposerAction(controller.getState())).toBe('stop');

    const updatesBeforeStaleDetail = pendingProjections.length;
    resolveRequestDetail(snapshot({ requests: [pendingRequest()] }));
    await vi.waitFor(() => expect(pendingProjections.length).toBeGreaterThan(updatesBeforeStaleDetail));
    expect(controller.getState().pendingRequests).toEqual([]);
    expect(selectSessionComposerAction(controller.getState())).toBe('stop');

    const updatesBeforeLateCreated = pendingProjections.length;
    eventListener?.(event('conversation.request.created', 22, { requestId: 'request-1', requestKind: 'command' }, 'request-created-late'));
    expect(controller.getState().pendingRequests).toEqual([]);
    expect(pendingProjections.slice(updatesBeforeLateCreated)).not.toContainEqual(['request-1']);
    expect(loadNativeConversation).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('keeps a locally resolved request tombstoned against an in-flight stale detail refresh', async () => {
    let eventListener: ((value: NativeConversationEvent) => void) | undefined;
    let resolveRequestDetail!: (value: NativeConversationSnapshot) => void;
    const requestDetail = new Promise<NativeConversationSnapshot>((resolve) => {
      resolveRequestDetail = resolve;
    });
    const loadNativeConversation = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockImplementationOnce(() => requestDetail);
    const client = {
      loadNativeConversation,
      connectEvents: vi.fn((listener: (value: NativeConversationEvent) => void) => {
        eventListener = listener;
        return { close: vi.fn() } as unknown as WebSocket;
      }),
      sendNativeMessage: vi.fn(),
      respondToNativeRequest: vi.fn(async () => ({
        operation: { status: 'resolved' },
        request: { ...pendingRequest(), status: 'resolved', response: { type: 'command', decision: 'decline' }, resolvedAt: '2026-07-13T00:00:21.000Z' },
      })),
    } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });
    const pendingProjections: string[][] = [];
    controller.subscribe(() => pendingProjections.push(controller.getState().pendingRequests.map((request) => request.id)));
    await controller.start();

    eventListener?.(event('conversation.request.created', 20, { requestId: 'request-1', requestKind: 'command' }, 'request-created-local'));
    await vi.waitFor(() => expect(loadNativeConversation).toHaveBeenCalledTimes(2));
    await controller.respondToRequest('request-1', { type: 'command', decision: 'decline' });
    expect(controller.getState().pendingRequests).toEqual([]);

    const updatesBeforeStaleDetail = pendingProjections.length;
    resolveRequestDetail(snapshot({ requests: [pendingRequest()] }));
    await vi.waitFor(() => expect(pendingProjections.length).toBeGreaterThan(updatesBeforeStaleDetail));
    expect(controller.getState().pendingRequests).toEqual([]);
    expect(selectSessionComposerAction(controller.getState())).toBe('stop');
    controller.dispose();
  });

  it('discards an old-thread request detail that resolves after the authoritative thread identity changes', async () => {
    let eventListener: ((value: NativeConversationEvent) => void) | undefined;
    let resolveOldThreadDetail!: (value: NativeConversationSnapshot) => void;
    const oldThreadDetail = new Promise<NativeConversationSnapshot>((resolve) => {
      resolveOldThreadDetail = resolve;
    });
    const loadNativeConversation = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockImplementationOnce(() => oldThreadDetail);
    const client = {
      loadNativeConversation,
      connectEvents: vi.fn((listener: (value: NativeConversationEvent) => void) => {
        eventListener = listener;
        return { close: vi.fn() } as unknown as WebSocket;
      }),
      sendNativeMessage: vi.fn(),
    } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });
    await controller.start();

    eventListener?.(event('conversation.request.created', 20, { requestId: 'request-old', requestKind: 'command' }, 'request-old-event'));
    await vi.waitFor(() => expect(loadNativeConversation).toHaveBeenCalledTimes(2));
    eventListener?.(
      event('conversation.thread.changed', 21, {
        threadId: 'thread-2',
        providerThreadId: 'thread-2',
        providerState: 'active',
      }),
    );
    resolveOldThreadDetail(snapshot({ requests: [{ ...pendingRequest(), id: 'request-old' }] }));

    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getState().providerThreadId).toBe('thread-2');
    expect(controller.getState().pendingRequests).toEqual([]);
    expect(controller.getState().conversationState).toBe('native_idle');
    controller.dispose();
  });

  it('replays a request-detail refresh raised on a new connection while the retired connection refresh is still in flight', async () => {
    const listeners: Array<(event: NativeConversationEvent) => void> = [];
    let resolveRetiredRefresh!: (value: NativeConversationSnapshot) => void;
    const retiredRefresh = new Promise<NativeConversationSnapshot>((resolve) => {
      resolveRetiredRefresh = resolve;
    });
    const secondRequest = { ...pendingRequest(), id: 'request-2', payload: { command: 'git status' } };
    const loadSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockImplementationOnce(() => retiredRefresh)
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ requests: [secondRequest] }));
    const client = {
      loadNativeConversation: loadSnapshot,
      connectEvents: vi.fn((listener: (event: NativeConversationEvent) => void) => {
        listeners.push(listener);
        return { close: vi.fn() } as unknown as WebSocket;
      }),
      sendNativeMessage: vi.fn(),
    } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });
    await controller.start();

    listeners[0](event('conversation.request.created', 15, { requestId: 'request-1', requestKind: 'command' }));
    await vi.waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));
    await controller.reconnect();
    expect(loadSnapshot).toHaveBeenCalledTimes(3);
    listeners[1](event('conversation.request.created', 16, { requestId: 'request-2', requestKind: 'command' }));
    resolveRetiredRefresh(snapshot({ requests: [pendingRequest()] }));

    await vi.waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(controller.getState().pendingRequests).toEqual([expect.objectContaining({ id: 'request-2', turnId: 'turn-1' })]));
    controller.dispose();
  });

  it('persists one retry envelope across controller recreation and only rotates ids after the user changes the request', async () => {
    const attachment: NativeConversationAttachment = { name: 'context.md', mime: 'text/markdown', size: 12, localPath: '/project/context.md' };
    const values = new Map<string, string>();
    const storage: SessionDraftStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    const sendFailure = new Error('send failed');
    const sendNativeMessage = vi
      .fn()
      .mockRejectedValueOnce(sendFailure)
      .mockResolvedValue({ operation: { status: 'active' }, conversation: { id: 'conversation-1' }, submission: { id: 'submission-2' } });
    const ids = ['idempotency-1', 'client-message-1', 'idempotency-2', 'client-message-2'];
    const client = {
      loadNativeConversation: vi.fn(async () => snapshot()),
      connectEvents: vi.fn(() => ({ close: vi.fn() }) as unknown as WebSocket),
      sendNativeMessage,
    } as unknown as SessionControllerClient;
    const controller = createSessionController({
      client,
      projectId: 'project-1',
      conversationId: 'conversation-1',
      storage,
      createId: () => ids.shift()!,
    });
    await controller.start();
    controller.setDraft('keep this prompt');
    controller.setAttachments([attachment]);

    await expect(controller.send('queue')).rejects.toBe(sendFailure);
    expect(sendNativeMessage).toHaveBeenNthCalledWith(1, 'project-1', 'conversation-1', {
      content: 'keep this prompt',
      attachments: [attachment],
      delivery: 'queue',
      idempotencyKey: 'idempotency-1',
      clientUserMessageId: 'client-message-1',
    });
    expect(controller.getState()).toMatchObject({ draft: 'keep this prompt', attachments: [attachment] });
    controller.dispose();

    const recreated = createSessionController({
      client,
      projectId: 'project-1',
      conversationId: 'conversation-1',
      storage,
      createId: () => ids.shift()!,
    });
    await recreated.start();
    await recreated.send('queue');
    expect(sendNativeMessage).toHaveBeenNthCalledWith(2, 'project-1', 'conversation-1', expect.objectContaining({ idempotencyKey: 'idempotency-1', clientUserMessageId: 'client-message-1' }));
    expect(sendNativeMessage.mock.calls[1]?.[2]).not.toHaveProperty('mode');
    expect(recreated.getState()).toMatchObject({ draft: '', attachments: [], conversationId: 'conversation-1', conversationState: 'active_prework' });

    recreated.setDraft('changed prompt');
    recreated.setAttachments([attachment]);
    await recreated.send('queue');
    expect(sendNativeMessage).toHaveBeenNthCalledWith(3, 'project-1', 'conversation-1', expect.objectContaining({ idempotencyKey: 'idempotency-2', clientUserMessageId: 'client-message-2' }));
    recreated.dispose();
  });

  it('deduplicates a repeated send while the same persisted envelope is in flight', async () => {
    const acceptance: NativeOperationAcceptance = {
      operation: { status: 'accepted' },
      conversation: { id: 'conversation-1' },
      submission: { id: 'submission-1' },
    };
    let resolveSend!: (value: NativeOperationAcceptance) => void;
    const sendResult = new Promise<NativeOperationAcceptance>((resolve) => {
      resolveSend = resolve;
    });
    const sendNativeMessage = vi.fn(() => sendResult);
    const ids = ['idempotency-1', 'renderer-client-1'];
    const client = {
      loadNativeConversation: vi.fn(async () => snapshot()),
      connectEvents: vi.fn(() => ({ close: vi.fn() }) as unknown as WebSocket),
      sendNativeMessage,
    } as unknown as SessionControllerClient;
    const controller = createSessionController({
      client,
      projectId: 'project-1',
      conversationId: 'conversation-1',
      createId: () => ids.shift()!,
    });
    await controller.start();
    controller.setDraft('send once');

    const first = controller.send('queue');
    const duplicate = controller.send('queue');
    expect(sendNativeMessage).toHaveBeenCalledTimes(1);
    expect(controller.getState().busyOperation).toBe('send:{"content":"send once","attachments":[],"delivery":"queue"}');
    resolveSend(acceptance);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([acceptance, acceptance]);
    expect(controller.getState().busyOperation).toBeNull();
    controller.dispose();
  });

  it('reconciles an accepted optimistic user item through a targeted snapshot without reconnecting', async () => {
    const loadNativeConversation = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(
        snapshot({
          messages: [
            {
              id: 'durable-message-1',
              conversationId: 'conversation-1',
              role: 'user',
              content: 'durable prompt',
              source: 'codex_native',
              metadata: { clientUserMessageId: 'renderer-client-1' },
              createdAt: '2026-07-13T00:00:01.000Z',
            },
          ],
        }),
      );
    const client = {
      loadNativeConversation,
      connectEvents: vi.fn(() => ({ close: vi.fn() }) as unknown as WebSocket),
      sendNativeMessage: vi.fn(async () => ({ operation: { status: 'accepted' }, conversation: { id: 'conversation-1' }, submission: { id: 'submission-1' } })),
    } as unknown as SessionControllerClient;
    const ids = ['idempotency-1', 'renderer-client-1'];
    const controller = createSessionController({
      client,
      projectId: 'project-1',
      conversationId: 'conversation-1',
      createId: () => ids.shift()!,
    });
    await controller.start();
    controller.setDraft('durable prompt');
    await controller.send('queue');
    const userItems = controller
      .getState()
      .itemOrder.map((key) => controller.getState().items[key])
      .filter((item) => item?.type === 'userMessage');
    expect(userItems).toHaveLength(1);
    expect(userItems[0]).toMatchObject({ localItemId: 'durable-message-1', text: 'durable prompt', optimistic: false, clientUserMessageId: 'renderer-client-1' });
    expect(loadNativeConversation).toHaveBeenCalledTimes(2);
    expect(client.connectEvents).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('keeps an accepted envelope stable when targeted hydration fails and never repeats the provider write', async () => {
    const values = new Map<string, string>();
    const storage: SessionDraftStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    const acceptance: NativeOperationAcceptance = {
      operation: { status: 'accepted' },
      conversation: { id: 'conversation-1' },
      submission: { id: 'submission-queued', status: 'queued' },
    };
    const durableQueuedSnapshot = snapshot({
      submissions: [
        {
          id: 'submission-queued',
          conversationId: 'conversation-1',
          content: 'queued prompt',
          status: 'queued',
          delivery: 'queue',
          clientUserMessageId: 'renderer-client-1',
          position: 1,
          pausedReason: null,
        },
      ] as unknown as NativeConversationSnapshot['submissions'],
      queue: {
        state: { type: 'active', turnId: 'turn-1', phase: 'prework' },
        submissions: [
          {
            id: 'submission-queued',
            conversationId: 'conversation-1',
            content: 'queued prompt',
            status: 'queued',
            delivery: 'queue',
            clientUserMessageId: 'renderer-client-1',
            position: 1,
            pausedReason: null,
          },
        ] as unknown as NativeConversationSnapshot['queue']['submissions'],
      },
    });
    const targetedFailure = new Error('targeted snapshot unavailable');
    const loadNativeConversation = vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(targetedFailure).mockResolvedValueOnce(durableQueuedSnapshot);
    const sendNativeMessage = vi.fn(async () => acceptance);
    const client = {
      loadNativeConversation,
      connectEvents: vi.fn(() => ({ close: vi.fn() }) as unknown as WebSocket),
      sendNativeMessage,
    } as unknown as SessionControllerClient;
    const ids = ['idempotency-1', 'renderer-client-1'];
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1', storage, createId: () => ids.shift()! });
    await controller.start();
    controller.setDraft('queued prompt');

    await expect(controller.send('queue')).resolves.toBe(acceptance);
    expect(sendNativeMessage).toHaveBeenCalledTimes(1);
    const acceptedItem = controller
      .getState()
      .itemOrder.map((key) => controller.getState().items[key])
      .find((item) => item?.clientUserMessageId === 'renderer-client-1');
    expect(acceptedItem).toMatchObject({ optimistic: true, status: 'queued' });
    expect(controller.getState().error).toMatchObject({ code: 'ZEUS_NATIVE_ACCEPTANCE_HYDRATION_PENDING', retryable: true, recoveryRequired: false });
    expect([...values.values()].join('\n')).toContain('"deliveryState":"accepted"');

    controller.setDraft('queued prompt');
    await expect(controller.send('queue')).resolves.toBe(acceptance);
    expect(sendNativeMessage).toHaveBeenCalledTimes(1);
    expect(loadNativeConversation).toHaveBeenCalledTimes(3);
    // Durable submission acceptance clears only the retry envelope. The visible
    // optimistic bubble remains renderer-owned until provider userMessage authority arrives.
    expect(controller.getState().itemOrder.some((key) => controller.getState().items[key]?.optimistic)).toBe(true);
    expect(values.size).toBe(0);
    controller.dispose();
  });

  it('clears only the accepted envelope draft during renderer restart reconciliation', async () => {
    const storageKey = 'zeus.native-session-draft:project-1:conversation-1';
    const acceptedEnvelope = {
      fingerprint: JSON.stringify({ content: 'already sent', attachments: [], delivery: 'queue' }),
      content: 'already sent',
      attachments: [],
      delivery: 'queue',
      idempotencyKey: 'idempotency-accepted',
      clientUserMessageId: 'client-accepted',
      deliveryState: 'accepted',
      acceptance: {
        operation: { status: 'accepted' },
        conversation: { id: 'conversation-1' },
        submission: { id: 'submission-accepted', status: 'queued' },
      },
    } as const;
    const durableSnapshot = snapshot({
      submissions: [
        {
          id: 'submission-accepted',
          conversationId: 'conversation-1',
          content: 'already sent',
          status: 'queued',
          delivery: 'queue',
          clientUserMessageId: 'client-accepted',
          position: 1,
          pausedReason: null,
        },
      ] as unknown as NativeConversationSnapshot['submissions'],
    });

    const sentValues = new Map([[storageKey, JSON.stringify({ draft: 'already sent', attachments: [], pendingSend: acceptedEnvelope })]]);
    const sentStorage: SessionDraftStorage = {
      getItem: (key) => sentValues.get(key) ?? null,
      setItem: (key, value) => sentValues.set(key, value),
      removeItem: (key) => sentValues.delete(key),
    };
    const sentController = createSessionController({
      client: {
        loadNativeConversation: vi.fn(async () => durableSnapshot),
        connectEvents: vi.fn(() => ({ close: vi.fn() }) as unknown as WebSocket),
        sendNativeMessage: vi.fn(),
      } as unknown as SessionControllerClient,
      projectId: 'project-1',
      conversationId: 'conversation-1',
      storage: sentStorage,
    });
    await sentController.start();
    expect(sentController.getState()).toMatchObject({ draft: '', attachments: [] });
    expect(sentValues.has(storageKey)).toBe(false);
    sentController.dispose();

    const newDraftValues = new Map([[storageKey, JSON.stringify({ draft: 'new unsent draft', attachments: [], pendingSend: acceptedEnvelope })]]);
    const newDraftStorage: SessionDraftStorage = {
      getItem: (key) => newDraftValues.get(key) ?? null,
      setItem: (key, value) => newDraftValues.set(key, value),
      removeItem: (key) => newDraftValues.delete(key),
    };
    const newDraftController = createSessionController({
      client: {
        loadNativeConversation: vi.fn(async () => durableSnapshot),
        connectEvents: vi.fn(() => ({ close: vi.fn() }) as unknown as WebSocket),
        sendNativeMessage: vi.fn(),
      } as unknown as SessionControllerClient,
      projectId: 'project-1',
      conversationId: 'conversation-1',
      storage: newDraftStorage,
    });
    await newDraftController.start();
    expect(newDraftController.getState().draft).toBe('new unsent draft');
    expect(JSON.parse(newDraftValues.get(storageKey) ?? '{}')).toEqual({ draft: 'new unsent draft', attachments: [] });
    newDraftController.dispose();
  });

  it('marks a direct idempotency recovery failure as non-retryable even without an explicit boolean', async () => {
    const recoveryFailure = {
      status: 409,
      error: 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED',
      message: 'provider outcome is unknown',
      operation: { status: 'recovery_required' },
    };
    const values = new Map<string, string>();
    const storage: SessionDraftStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    const loadNativeConversation = vi.fn(async () => snapshot());
    const sendNativeMessage = vi
      .fn()
      .mockRejectedValueOnce(recoveryFailure)
      .mockResolvedValueOnce({ operation: { status: 'accepted' }, conversation: { id: 'conversation-1' }, submission: { id: 'submission-after-recovery' } });
    const editNativeQueuedSubmission = vi.fn(async () => snapshot().queue);
    const deleteNativeQueuedSubmission = vi.fn(async () => snapshot().queue);
    const reorderNativeQueue = vi.fn(async () => snapshot().queue);
    const sendNativeQueuedNow = vi.fn(async () => ({ operation: { status: 'accepted' }, conversation: { id: 'conversation-1' } }));
    const resumeNativeQueue = vi.fn(async () => snapshot().queue);
    const interruptNativeTurn = vi.fn(async () => ({ operation: { status: 'interrupted' }, conversation: { id: 'conversation-1' } }));
    const respondToNativeRequest = vi.fn(async () => ({ operation: { status: 'responded' }, request: { ...pendingRequest(), status: 'resolved' } }));
    const client = {
      loadNativeConversation,
      connectEvents: vi.fn(() => ({ close: vi.fn() }) as unknown as WebSocket),
      sendNativeMessage,
      editNativeQueuedSubmission,
      deleteNativeQueuedSubmission,
      reorderNativeQueue,
      sendNativeQueuedNow,
      resumeNativeQueue,
      interruptNativeTurn,
      respondToNativeRequest,
    } as unknown as SessionControllerClient;
    const ids = ['idempotency-1', 'renderer-client-1', 'idempotency-2', 'renderer-client-2'];
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1', storage, createId: () => ids.shift()! });
    await controller.start();
    controller.setDraft('do not replay this provider write');

    await expect(controller.send('queue')).rejects.toBe(recoveryFailure);
    expect(controller.getState().error).toMatchObject({
      code: 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED',
      recoveryRequired: true,
      retryable: false,
      status: 409,
    });
    expect(selectSessionComposerAction(controller.getState())).toBe('disabled');
    expect(selectSessionStatusSemantics(controller.getState())).toEqual({ role: 'alert', ariaLive: 'assertive', label: 'provider outcome is unknown' });

    controller.setDraft('a different prompt must not bypass recovery');
    await expect(controller.send('queue')).rejects.toMatchObject({
      error: 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED',
      recoveryRequired: true,
    });
    expect(sendNativeMessage).toHaveBeenCalledTimes(1);
    await expect(controller.editQueuedSubmission('submission-queued', 'blocked edit')).rejects.toMatchObject({ recoveryRequired: true });
    await expect(controller.deleteQueuedSubmission('submission-queued')).rejects.toMatchObject({ recoveryRequired: true });
    await expect(controller.reorderQueue(['submission-queued'])).rejects.toMatchObject({ recoveryRequired: true });
    await expect(controller.sendQueuedNow('submission-queued')).rejects.toMatchObject({ recoveryRequired: true });
    await expect(controller.resumeQueue()).rejects.toMatchObject({ recoveryRequired: true });
    await expect(controller.interruptActiveTurn()).rejects.toMatchObject({ recoveryRequired: true });
    await expect(controller.respondToRequest('request-1', { type: 'command', decision: 'cancel' })).rejects.toMatchObject({ recoveryRequired: true });
    expect(editNativeQueuedSubmission).not.toHaveBeenCalled();
    expect(deleteNativeQueuedSubmission).not.toHaveBeenCalled();
    expect(reorderNativeQueue).not.toHaveBeenCalled();
    expect(sendNativeQueuedNow).not.toHaveBeenCalled();
    expect(resumeNativeQueue).not.toHaveBeenCalled();
    expect(interruptNativeTurn).not.toHaveBeenCalled();
    expect(respondToNativeRequest).not.toHaveBeenCalled();
    expect(controller.getState().error).toMatchObject({ code: 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED', recoveryRequired: true });
    expect([...values.values()].join('\n')).toContain('"recoveryRequired"');
    controller.dispose();

    const recreated = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1', storage, createId: () => ids.shift()! });
    await recreated.start();
    expect(recreated.getState().error).toMatchObject({ code: 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED', recoveryRequired: true });
    recreated.setDraft('still blocked after renderer restart');
    await expect(recreated.send('queue')).rejects.toMatchObject({ recoveryRequired: true });
    expect(sendNativeMessage).toHaveBeenCalledTimes(1);

    loadNativeConversation.mockResolvedValueOnce(
      snapshot({
        messages: [
          {
            id: 'durable-recovered-message',
            conversationId: 'conversation-1',
            role: 'user',
            content: 'do not replay this provider write',
            source: 'codex_native',
            metadata: { clientUserMessageId: 'renderer-client-1' },
            createdAt: '2026-07-13T00:00:01.000Z',
          },
        ],
      }),
    );
    await recreated.reconnect();
    expect(recreated.getState().error?.recoveryRequired).not.toBe(true);
    expect(recreated.getState().draft).toBe('still blocked after renderer restart');
    await expect(recreated.send('queue')).resolves.toMatchObject({ operation: { status: 'accepted' } });
    expect(sendNativeMessage).toHaveBeenCalledTimes(2);
    recreated.dispose();
  });

  it('durably latches a recovery-required WebSocket error before every provider mutation', async () => {
    const values = new Map<string, string>();
    const storage: SessionDraftStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    let eventListener: ((value: NativeConversationEvent) => void) | undefined;
    const sendNativeMessage = vi.fn(async () => ({ operation: { status: 'accepted' }, conversation: { id: 'conversation-1' } }));
    const sendNativeQueuedNow = vi.fn(async () => ({ operation: { status: 'accepted' }, conversation: { id: 'conversation-1' } }));
    const client = {
      loadNativeConversation: vi.fn(async () => snapshot()),
      connectEvents: vi.fn((listener: (value: NativeConversationEvent) => void) => {
        eventListener = listener;
        return { close: vi.fn() } as unknown as WebSocket;
      }),
      sendNativeMessage,
      sendNativeQueuedNow,
    } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1', storage });
    await controller.start();

    eventListener?.(
      event('conversation.native.error', 30, {
        error: {
          error: 'ZEUS_CODEX_REQUEST_GENERATION_STALE',
          message: 'The retired provider generation cannot accept writes.',
          recoveryRequired: true,
        },
      }),
    );
    expect(controller.getState().error).toMatchObject({ code: 'ZEUS_CODEX_REQUEST_GENERATION_STALE', recoveryRequired: true, retryable: false });
    controller.setDraft('must remain blocked after the event');
    await expect(controller.send('queue')).rejects.toMatchObject({ recoveryRequired: true });
    await expect(controller.sendQueuedNow('submission-queued')).rejects.toMatchObject({ recoveryRequired: true });
    expect(sendNativeMessage).not.toHaveBeenCalled();
    expect(sendNativeQueuedNow).not.toHaveBeenCalled();
    expect([...values.values()].join('\n')).toContain('ZEUS_CODEX_REQUEST_GENERATION_STALE');
    controller.dispose();

    const recreated = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1', storage });
    await recreated.start();
    expect(recreated.getState().error).toMatchObject({ code: 'ZEUS_CODEX_REQUEST_GENERATION_STALE', recoveryRequired: true });
    recreated.setDraft('renderer restart cannot clear the event latch');
    await expect(recreated.send('queue')).rejects.toMatchObject({ recoveryRequired: true });
    expect(sendNativeMessage).not.toHaveBeenCalled();
    recreated.dispose();
  });

  it('treats an authoritative paused recovery snapshot as a durable fail-closed write latch', async () => {
    const values = new Map<string, string>();
    const storage: SessionDraftStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    const recoveredSnapshot = snapshot({ queue: { state: { type: 'idle' }, submissions: [] }, providerState: 'idle' });
    const loadNativeConversation = vi
      .fn()
      .mockResolvedValueOnce(snapshot({ queue: { state: { type: 'paused', reason: 'recovery_required' }, submissions: [] }, providerState: 'failed' }))
      .mockResolvedValue(recoveredSnapshot);
    const sendNativeMessage = vi.fn(async () => ({ operation: { status: 'accepted' }, conversation: { id: 'conversation-1' } }));
    const client = {
      loadNativeConversation,
      connectEvents: vi.fn(() => ({ close: vi.fn() }) as unknown as WebSocket),
      sendNativeMessage,
    } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1', storage });

    await controller.start();
    expect(controller.getState()).toMatchObject({ conversationState: 'turn_failed', error: { recoveryRequired: true, retryable: false } });
    controller.setDraft('snapshot recovery must block writes');
    await expect(controller.send('queue')).rejects.toMatchObject({ recoveryRequired: true });
    expect(sendNativeMessage).not.toHaveBeenCalled();
    expect([...values.values()].join('\n')).toContain('"recoveryRequired"');

    await controller.reconnect();
    expect(controller.getState().error).toMatchObject({ recoveryRequired: true });
    await expect(controller.send('queue')).rejects.toMatchObject({ recoveryRequired: true });
    expect(sendNativeMessage).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('reconnects with afterEventId and hydrates snapshot behind a newly buffered socket', async () => {
    const listeners: Array<(event: NativeConversationEvent) => void> = [];
    const connectEvents = vi.fn((listener: (value: NativeConversationEvent) => void) => {
      listeners.push(listener);
      return { close: vi.fn() } as unknown as WebSocket;
    });
    const client = {
      loadNativeConversation: vi.fn(async () => snapshot()),
      connectEvents,
      sendNativeMessage: vi.fn(),
    } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });
    await controller.start();
    listeners[0](event('conversation.item.delta', 20, { itemId: 'item-1', textContent: 'first' }, 'event-20'));

    const reconnecting = controller.reconnect();
    expect(connectEvents).toHaveBeenLastCalledWith(expect.any(Function), { afterEventId: 'event-20' });
    listeners[1](event('conversation.item.delta', 21, { itemId: 'item-1', textContent: 'first second' }, 'event-21'));
    await reconnecting;

    expect(controller.getState().items[nativeSessionItemKey('conversation-1', 'thread-1', 'turn-1', 'item-1')]?.text).toBe('first second');
    expect(controller.getState().transportState).toBe('ready');
  });

  it('waits for socket open and automatically reconnects on close or error without active-close recursion', async () => {
    const sockets: TestEventSocket[] = [];
    const eventListeners: Array<(event: NativeConversationEvent) => void> = [];
    const connectEvents = vi.fn((listener: (value: NativeConversationEvent) => void) => {
      const socket = new TestEventSocket();
      sockets.push(socket);
      eventListeners.push(listener);
      return socket as unknown as WebSocket;
    });
    const loadNativeConversation = vi.fn(async () => snapshot());
    const client = { loadNativeConversation, connectEvents, sendNativeMessage: vi.fn() } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });

    const starting = controller.start();
    expect(loadNativeConversation).not.toHaveBeenCalled();
    sockets[0].emit('open');
    await starting;
    eventListeners[0](event('conversation.item.delta', 20, { itemId: 'item-1', textContent: 'first' }, 'event-20'));

    sockets[0].emit('close');
    await vi.waitFor(() => expect(connectEvents).toHaveBeenCalledTimes(2));
    expect(controller.getState().transportState).toBe('reconnecting');
    expect(connectEvents).toHaveBeenLastCalledWith(expect.any(Function), { afterEventId: 'event-20' });
    sockets[1].emit('open');
    await vi.waitFor(() => expect(controller.getState().transportState).toBe('ready'));

    sockets[1].emit('error');
    await vi.waitFor(() => expect(connectEvents).toHaveBeenCalledTimes(3));
    sockets[2].emit('open');
    await vi.waitFor(() => expect(controller.getState().transportState).toBe('ready'));
    controller.dispose();
    await Promise.resolve();
    expect(connectEvents).toHaveBeenCalledTimes(3);
  });

  it('keeps retrying an outage with capped exponential delays until a later socket becomes ready', async () => {
    const sockets: TestEventSocket[] = [];
    const delays: number[] = [];
    const connectEvents = vi.fn(() => {
      const socket = new TestEventSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    const client = {
      loadNativeConversation: vi.fn(async () => snapshot()),
      connectEvents,
      sendNativeMessage: vi.fn(),
    } as unknown as SessionControllerClient;
    const controller = createSessionController({
      client,
      projectId: 'project-1',
      conversationId: 'conversation-1',
      reconnectDelay: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    const starting = controller.start();
    sockets[0].emit('open');
    await starting;
    sockets[0].emit('close');
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(controller.getState().reconnectAttempt).toBe(1);
    sockets[1].emit('error');
    await vi.waitFor(() => expect(sockets).toHaveLength(3));
    sockets[2].emit('error');
    await vi.waitFor(() => expect(sockets).toHaveLength(4));
    expect(controller.getState().reconnectAttempt).toBe(2);
    sockets[3].emit('open');

    await vi.waitFor(() => expect(controller.getState().transportState).toBe('ready'));
    expect(controller.getState().reconnectAttempt).toBe(0);
    expect(delays.slice(0, 2)).toEqual([250, 500]);
    expect(connectEvents).toHaveBeenCalledTimes(4);
    controller.dispose();
    sockets[3].emit('close');
    await Promise.resolve();
    expect(connectEvents).toHaveBeenCalledTimes(4);
  });

  it('routes every socket lost during authoritative hydration through the capped reconnect scheduler', async () => {
    const sockets: TestEventSocket[] = [];
    const delays: number[] = [];
    const connectEvents = vi.fn(() => {
      const socket = new TestEventSocket();
      socket.readyState = 1;
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    let loadCount = 0;
    const loadNativeConversation = vi.fn(async () => {
      loadCount += 1;
      if (loadCount >= 2 && loadCount <= 4) sockets.at(-1)?.emit('close');
      return snapshot();
    });
    const controller = createSessionController({
      client: { loadNativeConversation, connectEvents, sendNativeMessage: vi.fn() } as unknown as SessionControllerClient,
      projectId: 'project-1',
      conversationId: 'conversation-1',
      reconnectDelay: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await controller.start();
    sockets[0].emit('close');

    await vi.waitFor(() => expect(controller.getState().transportState).toBe('ready'));
    expect(connectEvents).toHaveBeenCalledTimes(5);
    expect(loadNativeConversation).toHaveBeenCalledTimes(5);
    expect(delays).toEqual([250, 500, 1_000, 2_000]);
    expect(controller.getState().reconnectAttempt).toBe(0);
    controller.dispose();
  });

  it('cancels a scheduled automatic retry when a manual reconnect replaces it', async () => {
    const sockets: TestEventSocket[] = [];
    let releaseDelay!: () => void;
    const waitingDelay = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });
    const reconnectDelay = vi.fn(() => waitingDelay);
    const connectEvents = vi.fn(() => {
      const socket = new TestEventSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    const client = { loadNativeConversation: vi.fn(async () => snapshot()), connectEvents, sendNativeMessage: vi.fn() } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1', reconnectDelay });
    const starting = controller.start();
    sockets[0].emit('open');
    await starting;

    sockets[0].emit('close');
    await vi.waitFor(() => expect(reconnectDelay).toHaveBeenCalledTimes(1));
    const manual = controller.reconnect();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1].emit('open');
    await manual;
    releaseDelay();
    await Promise.resolve();
    await Promise.resolve();
    expect(connectEvents).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('refreshes rotated local-server configuration after a pre-open socket failure before authoritative hydration', async () => {
    const sockets: TestEventSocket[] = [];
    const connectEvents = vi.fn(() => {
      const socket = new TestEventSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    const loadNativeConversation = vi.fn(async () => snapshot());
    const client = { loadNativeConversation, connectEvents, sendNativeMessage: vi.fn() } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });

    const starting = controller.start();
    sockets[0].emit('error');
    await vi.waitFor(() => expect(connectEvents).toHaveBeenCalledTimes(2));
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    expect(loadNativeConversation).toHaveBeenCalledTimes(1);
    sockets[1].emit('open');
    await starting;

    expect(loadNativeConversation).toHaveBeenCalledTimes(2);
    expect(controller.getState().transportState).toBe('ready');
    controller.dispose();
  });

  it('closes a failed hydration socket and permits start to retry with a fresh connection', async () => {
    const close = vi.fn();
    const connectEvents = vi.fn(() => ({ close }) as unknown as WebSocket);
    const failure = new Error('snapshot failed');
    const loadNativeConversation = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(snapshot());
    const client = { loadNativeConversation, connectEvents, sendNativeMessage: vi.fn() } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });

    await expect(controller.start()).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
    await controller.start();
    expect(connectEvents).toHaveBeenCalledTimes(2);
    expect(controller.getState().transportState).toBe('ready');
    controller.dispose();
  });

  it('routes queue, request, send-now, resume, and interrupt actions through reducer state with in-flight deduplication', async () => {
    const queuedOne = {
      id: 'submission-1',
      content: 'first prompt',
      status: 'queued',
      position: 0,
      pausedReason: null,
    } as const;
    const queuedTwo = {
      id: 'submission-2',
      content: 'second prompt',
      status: 'queued',
      position: 1,
      pausedReason: null,
    } as const;
    const activeQueue: NativeQueueSnapshot = {
      state: { type: 'active', turnId: 'turn-1', phase: 'prework' },
      submissions: [queuedOne, queuedTwo],
    };
    const editedQueue: NativeQueueSnapshot = {
      ...activeQueue,
      submissions: [{ ...queuedOne, content: 'edited prompt' }, queuedTwo],
    };
    const deletedQueue: NativeQueueSnapshot = { ...activeQueue, submissions: [queuedTwo] };
    const reorderedQueue: NativeQueueSnapshot = {
      ...activeQueue,
      submissions: [
        { ...queuedTwo, position: 0 },
        { ...queuedOne, position: 1 },
      ],
    };
    const resumedQueue: NativeQueueSnapshot = { ...activeQueue, submissions: reorderedQueue.submissions };
    const acceptance: NativeOperationAcceptance = {
      operation: { status: 'accepted' },
      conversation: { id: 'conversation-1' },
      submission: { id: 'submission-2' },
    };
    let resolveSendNow!: (value: NativeOperationAcceptance) => void;
    const sendNowResult = new Promise<NativeOperationAcceptance>((resolve) => {
      resolveSendNow = resolve;
    });
    let resolveInterrupt!: (value: NativeOperationAcceptance) => void;
    const interruptResult = new Promise<NativeOperationAcceptance>((resolve) => {
      resolveInterrupt = resolve;
    });
    const resolvedRequest: NativePendingRequest = { ...pendingRequest(), status: 'resolved', response: { decision: 'accept' }, resolvedAt: '2026-07-13T00:00:02.000Z' };
    const client = {
      loadNativeConversation: vi.fn(async () => snapshot({ queue: activeQueue, submissions: activeQueue.submissions, requests: [pendingRequest()] })),
      connectEvents: vi.fn(() => ({ close: vi.fn() }) as unknown as WebSocket),
      sendNativeMessage: vi.fn(),
      editNativeQueuedSubmission: vi.fn(async () => editedQueue),
      deleteNativeQueuedSubmission: vi.fn(async () => deletedQueue),
      reorderNativeQueue: vi.fn(async () => reorderedQueue),
      sendNativeQueuedNow: vi.fn(() => sendNowResult),
      resumeNativeQueue: vi.fn(async () => resumedQueue),
      interruptNativeTurn: vi.fn(() => interruptResult),
      respondToNativeRequest: vi.fn(async () => ({ operation: { status: 'accepted' }, request: resolvedRequest })),
    } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });
    await controller.start();

    await controller.respondToRequest('request-1', { type: 'command', decision: 'accept' });
    expect(controller.getState().pendingRequests).toEqual([]);
    await controller.editQueuedSubmission('submission-1', 'edited prompt');
    expect(controller.getState().queue).toEqual(editedQueue);
    await controller.deleteQueuedSubmission('submission-1');
    expect(controller.getState().queue).toEqual(deletedQueue);
    await controller.reorderQueue(['submission-2', 'submission-1']);
    expect(controller.getState().queue).toEqual(reorderedQueue);
    await controller.resumeQueue();
    expect(controller.getState().queue).toEqual(resumedQueue);

    const firstSendNow = controller.sendQueuedNow('submission-2');
    const duplicateSendNow = controller.sendQueuedNow('submission-2');
    expect(client.sendNativeQueuedNow).toHaveBeenCalledTimes(1);
    expect(controller.getState().busyOperation).toBe('queue:send-now:submission-2');
    resolveSendNow(acceptance);
    await expect(Promise.all([firstSendNow, duplicateSendNow])).resolves.toEqual([acceptance, acceptance]);
    expect(controller.getState().busyOperation).toBeNull();

    const firstInterrupt = controller.interruptActiveTurn();
    const duplicateInterrupt = controller.interruptActiveTurn();
    expect(client.interruptNativeTurn).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ conversationState: 'interrupting', busyOperation: 'interrupt:turn-1' });
    resolveInterrupt(acceptance);
    await expect(Promise.all([firstInterrupt, duplicateInterrupt])).resolves.toEqual([acceptance, acceptance]);
    expect(controller.getState().busyOperation).toBeNull();
    controller.dispose();
  });

  it('does not enter interrupting while another controller operation owns the mutation lane', async () => {
    let resolveEdit!: (value: NativeQueueSnapshot) => void;
    const editResult = new Promise<NativeQueueSnapshot>((resolve) => {
      resolveEdit = resolve;
    });
    const queue = snapshot().queue;
    const client = {
      loadNativeConversation: vi.fn(async () => snapshot()),
      connectEvents: vi.fn(() => ({ close: vi.fn() }) as unknown as WebSocket),
      sendNativeMessage: vi.fn(),
      editNativeQueuedSubmission: vi.fn(() => editResult),
      interruptNativeTurn: vi.fn(),
    } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });
    await controller.start();

    const editing = controller.editQueuedSubmission('submission-1', 'edited');
    const interrupt = controller.interruptActiveTurn();
    expect(controller.getState().conversationState).toBe('active_prework');
    await expect(interrupt).rejects.toThrow('Session operation already in progress');
    expect(client.interruptNativeTurn).not.toHaveBeenCalled();
    resolveEdit(queue);
    await editing;
    controller.dispose();
  });

  it('deduplicates only byte-identical queue mutations instead of dropping a newer edit payload', async () => {
    let resolveEdit!: (value: NativeQueueSnapshot) => void;
    const editResult = new Promise<NativeQueueSnapshot>((resolve) => {
      resolveEdit = resolve;
    });
    const client = {
      loadNativeConversation: vi.fn(async () => snapshot()),
      connectEvents: vi.fn(() => ({ close: vi.fn() }) as unknown as WebSocket),
      sendNativeMessage: vi.fn(),
      editNativeQueuedSubmission: vi.fn(() => editResult),
    } as unknown as SessionControllerClient;
    const controller = createSessionController({ client, projectId: 'project-1', conversationId: 'conversation-1' });
    await controller.start();

    const first = controller.editQueuedSubmission('submission-1', 'first edit');
    const duplicate = controller.editQueuedSubmission('submission-1', 'first edit');
    const conflicting = controller.editQueuedSubmission('submission-1', 'newer edit');
    expect(client.editNativeQueuedSubmission).toHaveBeenCalledTimes(1);
    await expect(conflicting).rejects.toThrow('Session operation already in progress');
    resolveEdit(snapshot().queue);
    await expect(Promise.all([first, duplicate])).resolves.toHaveLength(2);
    controller.dispose();
  });
});
