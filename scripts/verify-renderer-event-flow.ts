import { createSessionController, type SessionControllerClient, sessionRealtimeBufferBudget } from '../apps/desktop/src/renderer/session/useSessionController.ts';
import { adaptConversationSnapshotV2, mergeConversationProcessV2 } from '../apps/desktop/src/renderer/session/conversationSnapshotV2Adapter.ts';
import type { NativeRealtimeEventEnvelope } from '../apps/desktop/src/renderer/session/sessionTypes.ts';

const projectId = 'renderer-event-flow-project';
const conversationId = 'renderer-event-flow-conversation';
const threadId = 'renderer-event-flow-thread';
const occurredAt = '2026-08-21T00:00:00.000Z';
const queue = { state: { type: 'idle' as const }, submissions: [] };

const snapshotV2 = {
  schemaVersion: 2 as const,
  structureGeneration: '2026-08-21-conversation-snapshot-v2' as const,
  conversationSchemaGeneration: '2026-08-16-unified-conversation-segments' as const,
  throughEventSeq: 0,
  eventStreamGeneration: 'zeus-conversation-sync-v1',
  conversation: {
    id: conversationId,
    projectId,
    taskId: null,
    title: 'Renderer event flow verifier',
    titleRedacted: false,
    status: 'active',
    stage: 'ready' as const,
    stageUpdatedAt: occurredAt,
    archived: false,
    transportKind: 'codex_native',
    providerState: 'idle',
    providerModel: 'probe-model',
    agentKind: 'codex',
    createdAt: occurredAt,
    updatedAt: occurredAt,
  },
  openSegment: {
    id: 'segment',
    runtimeKind: 'codex',
    state: 'ready',
    nativeSessionId: threadId,
    providerModel: 'probe-model',
    openedAt: occurredAt,
    acceptedAt: occurredAt,
    updatedAt: occurredAt,
  },
  activeTurn: null,
  recentClosedTurns: [],
  collections: {
    timeline: { throughSequence: 0 },
    modelHistory: { throughSequence: 0 },
    process: { throughSequence: 0 },
    resources: { available: false },
  },
  limits: { closedTurnLimit: 20, byteLimit: 96 * 1024, returnedTurnCount: 0, responseBytes: 1 },
};

const historyV2 = {
  schemaVersion: 2 as const,
  structureGeneration: '2026-08-21-conversation-snapshot-v2' as const,
  conversationId,
  kind: 'model_history' as const,
  throughEventSeq: 0,
  throughSequence: 0,
  items: [],
  hasMore: false,
  nextCursor: null,
  limits: { entryLimit: 48, byteLimit: 96 * 1024, returnedItems: 0, responseBytes: 1 },
};

const choice = {
  id: conversationId,
  projectId,
  taskId: null,
  title: 'Renderer event flow verifier',
  summary: null,
  status: 'active',
  stage: 'ready' as const,
  stageUpdatedAt: occurredAt,
  transportKind: 'codex_native',
  providerId: 'codex',
  providerThreadId: threadId,
  providerModel: 'probe-model',
  providerState: 'idle',
  createdAt: occurredAt,
  updatedAt: occurredAt,
  archived: false,
  hasUnreadAttention: false,
  attentionKind: 'none' as const,
  attentionRevision: 0,
  attentionTurnId: null,
  attentionUpdatedAt: null,
  pendingRequestKind: null,
  resumable: true,
  readOnly: false,
  permissionMode: 'read-only' as const,
  collaborationMode: 'default' as const,
};

const goal = {
  goal: null,
  timeline: [],
  capability: { supported: false, enabled: false, stage: null, reason: 'disabled' as const },
};

class VerifierSocket {
  readyState = 1;
  closeCount = 0;
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closeCount += 1;
    for (const listener of this.listeners.get('close') ?? []) listener();
  }
}

type EventPageLoader = SessionControllerClient['loadNativeConversationEvents'];

function createHarness(eventPageLoader?: EventPageLoader, snapshotSequence = 0, live = true) {
  let eventSink: ((event: NativeRealtimeEventEnvelope) => void) | null = null;
  let snapshotReads = 0;
  let sendCalls = 0;
  const sockets: VerifierSocket[] = [];
  const requestedAfterSequences: number[] = [];
  const connectedAfterSequences: number[] = [];
  const client = {
    async loadNativeConversationV2() {
      snapshotReads += 1;
      return { ...snapshotV2, throughEventSeq: snapshotSequence };
    },
    async loadNativeConversationModelHistoryV2() {
      return { ...historyV2, throughEventSeq: snapshotSequence };
    },
    async loadNativeConversationQueueV2() {
      return live
        ? {
            state: { type: 'active' as const, turnId: 'turn', phase: 'prework' as const },
            submissions: [],
          }
        : queue;
    },
    async loadNativeConversationChoice() {
      return choice;
    },
    async loadNativePendingRequests() {
      return { conversationId, requests: [] };
    },
    async loadNativeGoal() {
      return goal;
    },
    async loadNativeConversationEvents(project: string, conversation: string, options: Parameters<EventPageLoader>[2]) {
      requestedAfterSequences.push(options.afterSequence);
      if (eventPageLoader) return eventPageLoader(project, conversation, options);
      return {
        conversationId,
        conversationSchemaGeneration: '2026-08-16-unified-conversation-segments' as const,
        syncStreamGeneration: 'zeus-conversation-sync-v1' as const,
        baseSequence: null,
        throughEventSeq: options.afterSequence,
        nextCursor: options.afterSequence,
        hasMore: false,
        requestedBeforeBaseline: false,
        events: [],
      };
    },
    connectEvents(nextEventSink: (event: NativeRealtimeEventEnvelope) => void, options: { afterSequence: number }) {
      eventSink = nextEventSink;
      connectedAfterSequences.push(options.afterSequence);
      const socket = new VerifierSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    async sendNativeMessage() {
      sendCalls += 1;
      return { operation: { status: 'accepted' }, conversation: { id: conversationId } };
    },
  } as unknown as SessionControllerClient;
  const controller = createSessionController({
    client,
    projectId,
    conversationId,
    storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    reconnectDelay: async () => undefined,
  });
  return {
    controller,
    emit(event: NativeRealtimeEventEnvelope) {
      if (!eventSink) throw new Error('Verifier socket is not connected.');
      eventSink(event);
    },
    sockets,
    connectedAfterSequences,
    requestedAfterSequences,
    snapshotReads: () => snapshotReads,
    sendCalls: () => sendCalls,
  };
}

async function verifyIdleHistoryDoesNotSubscribe() {
  const harness = createHarness(undefined, 0, false);
  await harness.controller.start();
  assert(harness.connectedAfterSequences.length === 0, 'Idle history hydration must not establish a realtime subscription.');
  assert(harness.controller.getState().transportState === 'ready', 'Idle history must remain readable and send-ready without a realtime socket.');
  harness.controller.setDraft('continue');
  await harness.controller.send('queue');
  await waitUntil(() => harness.connectedAfterSequences.length === 1 && harness.sendCalls() === 1, 'idle history lazy send connection');
  harness.controller.dispose();
  return {
    initialConnections: 0,
    sendTriggeredConnections: harness.connectedAfterSequences.length,
    sendCalls: harness.sendCalls(),
    transportState: 'ready',
  };
}

function verifyInternalPayloadsStayOutOfTranscript() {
  const history = {
    ...historyV2,
    throughSequence: 2,
    items: [
      {
        id: 'tool-call-history',
        sequence: 1,
        turnId: 'turn',
        submissionId: null,
        segmentId: 'segment',
        role: 'assistant',
        toolPairId: null,
        confirmedAt: occurredAt,
        content: {
          preview: '{"type":"tool_call","itemType":"commandExecution","payload":{"command":"pwd"',
          byteLength: 4_096,
          truncated: true,
          redacted: false,
          contentHandle: 'tool-call-handle',
          refreshRequired: false,
        },
        toolResult: null,
      },
      {
        id: 'assistant-history',
        sequence: 2,
        turnId: 'turn',
        submissionId: null,
        segmentId: 'segment',
        role: 'assistant',
        toolPairId: null,
        confirmedAt: occurredAt,
        content: {
          preview: '最终回答',
          byteLength: 12,
          truncated: false,
          redacted: false,
          contentHandle: null,
          refreshRequired: false,
        },
        toolResult: null,
      },
    ],
    limits: { ...historyV2.limits, returnedItems: 2 },
  };
  const adapted = adaptConversationSnapshotV2({
    snapshot: {
      ...snapshotV2,
      collections: { ...snapshotV2.collections, modelHistory: { throughSequence: 2 } },
    },
    history,
    queue,
    requests: [],
    choice,
    goal,
  });
  assert(adapted.items.length === 1 && adapted.items[0]?.text === '最终回答', 'Internal tool_call projections must never become visible assistant transcript rows.');
  const merged = mergeConversationProcessV2(adapted, 'turn', {
    schemaVersion: 2,
    structureGeneration: '2026-08-21-conversation-snapshot-v2',
    conversationId,
    kind: 'process',
    throughEventSeq: 0,
    throughSequence: 1,
    items: [
      {
        id: 'command-process',
        sequence: 1,
        turnId: 'turn',
        segmentId: 'segment',
        kind: 'command',
        status: 'completed',
        title: '执行命令',
        sourceEventId: 'codex:item:command-process',
        startedAt: occurredAt,
        completedAt: occurredAt,
        detail: {
          preview: '{"provider":"codex","itemType":"commandExecution","payload":{"command":"pwd","aggregatedOutput":"internal"',
          byteLength: 4_096,
          truncated: true,
          redacted: false,
          contentHandle: 'process-detail-handle',
          refreshRequired: false,
        },
        toolResult: null,
      },
    ],
    hasMore: false,
    nextCursor: null,
    limits: { entryLimit: 64, byteLimit: 128 * 1024, returnedItems: 1, responseBytes: 512 },
  });
  const command = Object.values(merged.items).find((item) => item.id === 'command-process');
  assert(command?.text === 'pwd', 'Truncated process JSON must project a readable command instead of the internal JSON wrapper.');
  assert(command.payload.command === 'pwd' && !Object.prototype.hasOwnProperty.call(command.payload, 'detail'), 'Process items must expose presentation fields without retaining the internal detail wrapper.');
  return {
    visibleHistoryItems: adapted.items.map((item) => item.id),
    commandText: command.text,
    internalDetailExposed: false,
  };
}

async function verifyActiveSnapshotWatermarkSubscription() {
  const snapshotSequence = 483;
  const harness = createHarness(undefined, snapshotSequence);
  await harness.controller.start();
  assert(harness.connectedAfterSequences.length === 1 && harness.connectedAfterSequences[0] === snapshotSequence, 'Active hydration must subscribe after the authoritative snapshot watermark.');
  harness.controller.dispose();
  return { snapshotSequence, connectedAfterSequences: harness.connectedAfterSequences };
}

async function verifyIdleTransitionReleasesSubscription() {
  const harness = createHarness();
  await harness.controller.start();
  harness.emit(conversationEvent(1, 'conversation.queue.changed', { queue }));
  await waitUntil(() => harness.sockets[0]?.closeCount === 1, 'idle transition realtime release');
  assert(harness.controller.getState().transportState === 'ready', 'Releasing an idle subscription must not mark the readable history disconnected.');
  assert(harness.connectedAfterSequences.length === 1, 'Intentional idle release must not schedule a reconnect loop.');
  harness.controller.dispose();
  return { socketClosed: 1, connections: harness.connectedAfterSequences.length, transportState: 'ready' };
}

function conversationEvent(sequence: number, type: string, fields: Record<string, unknown> = {}): NativeRealtimeEventEnvelope {
  return {
    id: `event-${sequence}`,
    type,
    createdAt: occurredAt,
    payload: {
      projectId,
      conversationId,
      threadId,
      generationId: 'generation',
      conversationSchemaGeneration: '2026-08-16-unified-conversation-segments',
      syncStreamGeneration: 'zeus-conversation-sync-v1',
      entityRevision: sequence,
      sequence,
      ...fields,
    },
  };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Renderer event-flow verifier timed out: ${label}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function verifyRenderDeltaOverflow() {
  const harness = createHarness();
  await harness.controller.start();
  for (let sequence = 1; sequence <= sessionRealtimeBufferBudget.maxEntries + 1; sequence += 1) {
    harness.emit(
      conversationEvent(sequence, 'conversation.item.delta', {
        turnId: 'turn',
        itemId: `item-${sequence}`,
        itemType: 'agentMessage',
        itemPayload: {},
        textContent: 'x',
      }),
    );
  }
  const overflow = harness.controller.getDiagnostics();
  assert(overflow.syncProjectionSuspended, 'Render-delta overflow must suspend incremental projection.');
  assert(harness.sockets[0]?.closeCount === 1, 'Render-delta overflow must close the active socket exactly once.');
  assert(overflow.pendingRenderDeltaEntries === 0 && overflow.pendingRenderDeltaBytes === 0, 'Render-delta overflow must clear unprojected local deltas.');
  assert(overflow.realtimeBufferWatermarks['render-delta']?.entries === sessionRealtimeBufferBudget.maxEntries, 'Render-delta high watermark must reach the hard entry budget.');
  await waitUntil(() => harness.snapshotReads() >= 2 && harness.controller.getState().transportState === 'ready', 'render-delta Snapshot V2 recovery');
  const recovered = harness.controller.getDiagnostics();
  assert(!recovered.syncProjectionSuspended, 'Snapshot V2 recovery must reopen incremental projection.');
  assert(harness.sockets.length === 2, 'Snapshot V2 recovery must establish a fresh socket.');
  harness.controller.dispose();
  return {
    suspendedOnOverflow: overflow.syncProjectionSuspended,
    socketClosed: 1,
    watermarkEntries: overflow.realtimeBufferWatermarks['render-delta']?.entries ?? 0,
    snapshotReads: harness.snapshotReads(),
    recoveredTransport: 'ready',
  };
}

async function verifyGapByteOverflow() {
  const harness = createHarness();
  await harness.controller.start();
  harness.emit(
    conversationEvent(2, 'conversation.settings.changed', {
      model: 'x'.repeat(Math.ceil(sessionRealtimeBufferBudget.maxBytes / 3) + 100),
      effort: 'high',
    }),
  );
  const overflow = harness.controller.getDiagnostics();
  assert(overflow.syncProjectionSuspended, 'Sync-gap byte overflow must suspend incremental projection.');
  assert(harness.sockets[0]?.closeCount === 1, 'Sync-gap byte overflow must close the active socket exactly once.');
  assert(overflow.pendingSyncGapEntries === 0 && overflow.pendingSyncGapBytes === 0, 'Sync-gap overflow must clear unprojected local events.');
  await waitUntil(() => harness.snapshotReads() >= 2 && harness.controller.getState().transportState === 'ready', 'sync-gap Snapshot V2 recovery');
  assert(!harness.controller.getDiagnostics().syncProjectionSuspended, 'Snapshot V2 recovery must resume after sync-gap overflow.');
  harness.controller.dispose();
  return { suspendedOnOverflow: true, socketClosed: 1, snapshotReads: harness.snapshotReads(), recoveredTransport: 'ready' };
}

async function verifyContiguousGapReplay() {
  const missingEvents = [conversationEvent(1, 'conversation.settings.changed', { model: 'model-1' }), conversationEvent(2, 'conversation.settings.changed', { model: 'model-2' })];
  const harness = createHarness(async (_project, _conversation, options) => ({
    conversationId,
    conversationSchemaGeneration: '2026-08-16-unified-conversation-segments',
    syncStreamGeneration: 'zeus-conversation-sync-v1',
    baseSequence: 1,
    throughEventSeq: 2,
    nextCursor: 2,
    hasMore: false,
    requestedBeforeBaseline: false,
    events: options.afterSequence === 0 ? missingEvents : [],
  }));
  await harness.controller.start();
  harness.emit(conversationEvent(3, 'conversation.settings.changed', { model: 'model-3' }));
  await waitUntil(() => harness.controller.getDiagnostics().lastAppliedSyncEventSequence === 3, 'contiguous gap replay');
  const diagnostics = harness.controller.getDiagnostics();
  assert(harness.requestedAfterSequences.length === 1 && harness.requestedAfterSequences[0] === 0, 'Gap fetch must start at the last applied sequence.');
  assert(diagnostics.pendingSyncGapEntries === 0, 'Buffered sequence 3 must apply only after sequences 1 and 2.');
  assert(harness.controller.getState().providerSettings?.model === 'model-3', 'The buffered event must become the final projection after the gap closes.');
  harness.controller.dispose();
  return {
    requestedAfterSequences: harness.requestedAfterSequences,
    lastAppliedSequence: diagnostics.lastAppliedSyncEventSequence,
    pendingGapEntries: diagnostics.pendingSyncGapEntries,
    finalModel: 'model-3',
  };
}

const result = {
  budget: sessionRealtimeBufferBudget,
  internalPayloadVisibility: verifyInternalPayloadsStayOutOfTranscript(),
  idleHistoryWithoutSubscription: await verifyIdleHistoryDoesNotSubscribe(),
  activeSnapshotWatermarkSubscription: await verifyActiveSnapshotWatermarkSubscription(),
  idleTransitionReleasesSubscription: await verifyIdleTransitionReleasesSubscription(),
  renderDeltaOverflow: await verifyRenderDeltaOverflow(),
  syncGapByteOverflow: await verifyGapByteOverflow(),
  contiguousGapReplay: await verifyContiguousGapReplay(),
};

process.stdout.write(`${JSON.stringify(result)}\n`);
