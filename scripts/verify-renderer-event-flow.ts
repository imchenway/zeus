import {
    createSessionController,
    type SessionControllerClient,
    sessionRealtimeBufferBudget
} from '../apps/desktop/src/renderer/session/useSessionController.ts';
import {
    adaptConversationSnapshotV2,
    mergeConversationProcessV2
} from '../apps/desktop/src/renderer/session/conversationSnapshotV2Adapter.ts';
import {createHydratedSessionState, sessionReducer} from '../apps/desktop/src/renderer/session/sessionReducer.ts';
import type {
    NativePlanImplementationRequest,
    NativeRealtimeEventEnvelope
} from '../apps/desktop/src/renderer/session/sessionTypes.ts';

const projectId = 'renderer-event-flow-project';
const conversationId = 'renderer-event-flow-conversation';
const threadId = 'renderer-event-flow-thread';
const occurredAt = '2026-08-21T00:00:00.000Z';
const queue = { state: { type: 'idle' as const }, submissions: [] };

const snapshotV2 = {
  schemaVersion: 2 as const,
    structureGeneration: '2026-09-01-conversation-snapshot-v2-turn-output-anchors' as const,
  conversationSchemaGeneration: '2026-08-16-unified-conversation-segments' as const,
  throughEventSeq: 0,
  eventStreamGeneration: 'zeus-conversation-sync-v2',
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
    providerSettings: null,
    nextTurnSettings: null,
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
    structureGeneration: '2026-09-01-conversation-snapshot-v2-turn-output-anchors' as const,
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

function createHarness(eventPageLoader?: EventPageLoader, snapshotSequence = 0, live = true, planImplementationRequests: NativePlanImplementationRequest[] = [], persistedDraft: string | null = null, sendFailure?: Error) {
  let eventSink: ((event: NativeRealtimeEventEnvelope) => void) | null = null;
  let snapshotReads = 0;
  let sendCalls = 0;
  const sentMessages: Array<Record<string, unknown>> = [];
  let storedDraft = persistedDraft;
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
      if (planImplementationRequests.some((request) => request.status === 'pending')) {
        return {
          state: { type: 'idle' as const },
          waitReason: 'plan_confirmation' as const,
          submissions: [],
        };
      }
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
      return { conversationId, requests: [], planImplementationRequests };
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
        syncStreamGeneration: 'zeus-conversation-sync-v2' as const,
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
    async sendNativeMessage(_project: string, _conversation: string, input: Record<string, unknown>) {
      sendCalls += 1;
      sentMessages.push(input);
      if (sendFailure) throw sendFailure;
      return { operation: { status: 'accepted' }, conversation: { id: conversationId } };
    },
  } as unknown as SessionControllerClient;
  const controller = createSessionController({
    client,
    projectId,
    conversationId,
    storage: {
      getItem: () => storedDraft,
      setItem: (_key, value) => {
        storedDraft = value;
      },
      removeItem: () => {
        storedDraft = null;
      },
    },
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
    sentMessages,
    persistedDraft: () => storedDraft,
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

async function verifyRestartedPendingSendReplaysOnce() {
  const originalIdentity = {
    idempotencyKey: 'renderer-restart-idempotency',
    clientUserMessageId: 'renderer-restart-client-message',
  };
  const persisted = JSON.stringify({
    draft: '',
    attachments: [],
    contextDraft: { responseAnnotations: [], codeComments: [] },
    pendingSend: {
      fingerprint: 'renderer-restart-fingerprint',
      content: 'restart recovery marker',
      displayText: 'restart recovery marker',
      draft: 'restart recovery marker',
      attachments: [],
      composerAttachments: [],
      browserSubmission: null,
      contextDraft: { responseAnnotations: [], codeComments: [] },
      delivery: 'queue',
      collaborationMode: 'default',
      ...originalIdentity,
      startedAt: occurredAt,
      autoReplayCount: 0,
      deliveryState: 'failed',
      deliveryError: { message: 'Execution Host restarted before acceptance.', code: 'ZEUS_LOCAL_API_UNAVAILABLE', recoveryRequired: false, retryable: true },
    },
  });
  const failure = Object.assign(new Error('Execution Host is still unavailable.'), { code: 'ZEUS_LOCAL_API_UNAVAILABLE' });
  const first = createHarness(undefined, 0, true, [], persisted, failure);
  await first.controller.start();
  await waitUntil(() => first.sendCalls() === 1, 'restored pending send automatic replay');
  const firstRequest = first.sentMessages[0]!;
  assert(firstRequest.idempotencyKey === originalIdentity.idempotencyKey, 'Automatic replay must preserve the original idempotency key.');
  assert(firstRequest.clientUserMessageId === originalIdentity.clientUserMessageId, 'Automatic replay must preserve the original client message id.');
  await waitUntil(() => JSON.parse(first.persistedDraft() ?? '{}').pendingSend?.deliveryState === 'failed', 'automatic replay failure persistence');
  const afterFirstReplay = first.persistedDraft();
  assert(JSON.parse(afterFirstReplay ?? '{}').pendingSend?.autoReplayCount === 1, 'Automatic replay count must be persisted before the retry can fail.');
  first.controller.dispose();

  const second = createHarness(undefined, 0, true, [], afterFirstReplay, failure);
  await second.controller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(second.sendCalls() === 0, 'A second Renderer restart must not start an automatic replay loop.');
  await second.controller.retryPendingSend(originalIdentity.clientUserMessageId).catch(() => undefined);
  assert(second.sendCalls() === 1, 'Explicit retry must remain available after the one automatic replay.');
  assert(second.sentMessages[0]?.idempotencyKey === originalIdentity.idempotencyKey, 'Explicit retry must preserve the original idempotency key.');
  assert(second.sentMessages[0]?.clientUserMessageId === originalIdentity.clientUserMessageId, 'Explicit retry must preserve the original client message id.');
  second.controller.dispose();
  return { automaticReplayCalls: 1, secondRestartAutomaticCalls: 0, explicitRetryCalls: 1, identitiesPreserved: true };
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
        clientUserMessageId: null,
        providerItemId: null,
        reasoningSummary: false,
        phase: null,
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
        id: 'reasoning-history',
        sequence: 2,
        turnId: 'turn',
        submissionId: null,
        clientUserMessageId: null,
        providerItemId: 'reasoning-history-provider-item',
        reasoningSummary: true,
        phase: null,
        segmentId: 'segment',
        role: 'assistant',
        toolPairId: null,
        confirmedAt: occurredAt,
        content: {
          preview: '**等待命令完成**',
          byteLength: 24,
          truncated: false,
          redacted: false,
          contentHandle: null,
          refreshRequired: false,
        },
        toolResult: null,
      },
      {
        id: 'assistant-history',
        sequence: 3,
        turnId: 'turn',
        submissionId: null,
        clientUserMessageId: null,
        providerItemId: 'assistant-history-provider-item',
        reasoningSummary: false,
        phase: 'final_answer',
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
    limits: { ...historyV2.limits, returnedItems: 3 },
  };
  const adapted = adaptConversationSnapshotV2({
    snapshot: {
      ...snapshotV2,
      collections: { ...snapshotV2.collections, modelHistory: { throughSequence: 3 } },
    },
    history,
    queue,
    requests: [],
    planImplementationRequests: [],
    choice,
    goal,
  });
  assert(adapted.items.length === 2 && adapted.items[0]?.type === 'reasoning' && adapted.items[0]?.phase === 'prework', 'Snapshot V2 reasoning identity must survive a plain-text history projection.');
  assert(adapted.items[1]?.text === '最终回答' && adapted.items[1]?.type === 'agentMessage', 'Internal tool_call projections must never become visible assistant transcript rows.');
  const merged = mergeConversationProcessV2(adapted, 'turn', {
    schemaVersion: 2,
      structureGeneration: '2026-09-01-conversation-snapshot-v2-turn-output-anchors',
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
        providerItemId: 'command-process',
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
    reasoningHistoryType: adapted.items[0]?.type,
    commandText: command.text,
    internalDetailExposed: false,
  };
}

function verifyProcessPageDoesNotDowngradeLiveTerminalState() {
  const providerTurnId = 'provider-terminal-turn';
  const localTurnId = 'local-terminal-turn';
  const activeSnapshot = {
    ...snapshotV2,
    activeTurn: {
      id: localTurnId,
      providerTurnId,
      submissionId: null,
      status: 'running',
      hasError: false,
      hasPlan: false,
      plan: null,
      startedAt: occurredAt,
      completedAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      agentKind: 'codex',
      process: { available: true, latestSequence: 1 },
      resourcesAvailable: false,
      changeSetAvailable: false,
    },
    limits: { ...snapshotV2.limits, returnedTurnCount: 1 },
  };
  const adapted = adaptConversationSnapshotV2({
    snapshot: activeSnapshot,
    history: historyV2,
    queue,
    requests: [],
    planImplementationRequests: [],
    choice,
    goal,
  });
  let state = createHydratedSessionState(adapted);
  state = sessionReducer(state, {
    type: 'event_received',
    event: conversationEvent(1, 'conversation.item.completed', {
      turnId: providerTurnId,
      itemId: 'command-process',
      itemType: 'commandExecution',
      itemPayload: { command: 'pwd' },
      status: 'completed',
      textContent: 'pwd',
    }),
  });
  state = sessionReducer(state, {
    type: 'event_received',
    event: conversationEvent(2, 'conversation.item.completed', {
      turnId: providerTurnId,
      itemId: 'final-answer',
      itemType: 'agentMessage',
      itemPayload: {},
      phase: 'final_answer',
      status: 'completed',
      textContent: 'FINAL-OK',
    }),
  });
  state = sessionReducer(state, {
    type: 'event_received',
    event: conversationEvent(3, 'conversation.turn.completed', {
      turnId: providerTurnId,
      status: 'completed',
      completedAt: '2026-08-21T00:00:03.000Z',
    }),
  });

  const staleProcessPage = mergeConversationProcessV2(adapted, providerTurnId, {
    schemaVersion: 2,
      structureGeneration: '2026-09-01-conversation-snapshot-v2-turn-output-anchors',
    conversationId,
    kind: 'process',
    throughEventSeq: 0,
    throughSequence: 1,
    items: [
      {
        id: 'durable-command-process',
        sequence: 1,
        turnId: localTurnId,
        segmentId: 'segment',
        providerItemId: 'command-process',
        kind: 'command',
        status: 'completed',
        title: '执行命令',
        sourceEventId: 'codex:item:command-process',
        startedAt: occurredAt,
        completedAt: '2026-08-21T00:00:01.000Z',
        detail: {
          preview: '{"provider":"codex","itemType":"commandExecution","payload":{"command":"pwd"}}',
          byteLength: 84,
          truncated: false,
          redacted: false,
          contentHandle: null,
          refreshRequired: false,
        },
        toolResult: null,
      },
    ],
    hasMore: false,
    nextCursor: null,
    limits: { entryLimit: 32, byteLimit: 96 * 1024, returnedItems: 1, responseBytes: 256 },
  });
  state = sessionReducer(state, { type: 'snapshot_v2_page_merged', snapshot: staleProcessPage });
  const commandItems = Object.values(state.items).filter((item) => item.providerItemId === 'command-process');
  assert(state.activeTurnId === null && state.conversationState === 'native_idle', 'A stale process page must not downgrade a completed realtime turn to active.');
  assert(state.turnsByProviderId[providerTurnId]?.status === 'completed', 'A stale process page must preserve the stronger realtime terminal turn.');
  assert(commandItems.length === 1, 'The durable process row and realtime Provider item must merge by provider item identity.');
  assert(
    Object.values(state.items).some((item) => item.providerItemId === 'final-answer' && item.text === 'FINAL-OK'),
    'A process page must not erase a realtime final answer.',
  );
  return {
    commandItems: commandItems.length,
    finalAnswerPreserved: true,
    conversationState: state.conversationState,
    turnStatus: state.turnsByProviderId[providerTurnId]?.status,
  };
}

function verifyQueuedSubmissionCanChangeNativeThread() {
  const submissionId = 'cross-runtime-submission';
  const nextThreadId = 'cross-runtime-thread';
  const nextTurnId = 'cross-runtime-turn';
  const adapted = adaptConversationSnapshotV2({
    snapshot: snapshotV2,
    history: historyV2,
    queue: {
      state: { type: 'idle' as const },
      submissions: [],
    },
    requests: [],
    planImplementationRequests: [],
    choice,
    goal,
  });
  let state = createHydratedSessionState(adapted);
  const previousThreadId = state.providerThreadId;
  state = sessionReducer(state, {
    type: 'event_received',
    event: conversationEvent(1, 'conversation.queue.changed', {
      threadId: nextThreadId,
      providerThreadId: nextThreadId,
      turnId: nextTurnId,
      submissionId,
      queue: { state: { type: 'active', turnId: nextTurnId, phase: 'prework' }, submissions: [], waitReason: 'current_turn' },
    }),
  });
  assert(state.providerThreadId === previousThreadId, 'An incomplete cross-thread queue fact must not replace the selected Provider identity.');
  state = sessionReducer(state, {
    type: 'event_received',
    event: conversationEvent(2, 'conversation.queue.changed', {
      threadId: nextThreadId,
      providerThreadId: nextThreadId,
      turnId: nextTurnId,
      providerTurnId: nextTurnId,
      submissionId,
      queue: { state: { type: 'active', turnId: nextTurnId, phase: 'prework' }, submissions: [], waitReason: 'current_turn' },
    }),
  });
  assert(state.providerThreadId === nextThreadId, 'A new thread may replace the old identity when queue.changed names a known queued submission.');
  assert(state.activeTurnId === nextTurnId && state.conversationState === 'active_prework', 'The accepted cross-runtime queue head must become active immediately.');
  return { providerThreadId: state.providerThreadId, activeTurnId: state.activeTurnId };
}

function verifySnapshotV2SettingsAndPlanRestoration() {
  const plan = {
    explanation: '保留已完成的开发计划',
    steps: [
      { step: '读取历史快照', status: 'completed' as const },
      { step: '继续实施', status: 'inProgress' as const },
    ],
  };
  const adapted = adaptConversationSnapshotV2({
    snapshot: {
      ...snapshotV2,
      conversation: {
        ...snapshotV2.conversation,
        providerSettings: {
          generationId: 'generation-xhigh',
          sequence: 7,
          model: 'probe-model',
          effort: 'xhigh',
          serviceTier: 'priority',
        },
        nextTurnSettings: {
          model: 'probe-model',
          effort: 'xhigh',
          serviceTier: 'priority',
          permissionMode: 'full-access',
          collaborationMode: 'plan',
        },
      },
      recentClosedTurns: [
        {
          id: 'plan-turn',
          providerTurnId: 'provider-plan-turn',
          submissionId: null,
          status: 'completed',
          hasError: false,
          hasPlan: true,
          plan,
          startedAt: occurredAt,
          completedAt: occurredAt,
          createdAt: occurredAt,
          updatedAt: occurredAt,
          agentKind: 'codex',
          process: { available: false, latestSequence: 0 },
          resourcesAvailable: false,
          changeSetAvailable: false,
        },
      ],
      limits: { ...snapshotV2.limits, returnedTurnCount: 1 },
    },
    history: historyV2,
    queue,
    requests: [],
    planImplementationRequests: [],
    choice,
    goal,
  });
  assert(adapted.providerSettings?.effort === 'xhigh', 'Snapshot V2 must restore the authoritative provider effort.');
  assert(adapted.nextTurnSettings?.effort === 'xhigh' && adapted.nextTurnSettings.collaborationMode === 'plan', 'Snapshot V2 must restore the next-turn PLAN settings without falling back to low/default.');
  assert(adapted.turns[0]?.plan?.steps[1]?.status === 'inProgress', 'Snapshot V2 must restore the persisted development plan after the active turn closes.');
  return {
    providerEffort: adapted.providerSettings.effort,
    nextTurnEffort: adapted.nextTurnSettings.effort,
    collaborationMode: adapted.nextTurnSettings.collaborationMode,
    restoredPlanSteps: adapted.turns[0]?.plan?.steps.length ?? 0,
  };
}

async function verifyPendingPlanConfirmationRestoration() {
  const request: NativePlanImplementationRequest = {
    id: 'plan-request',
    conversationId,
    turnId: 'plan-turn',
    planItemId: 'plan-item',
    status: 'pending',
    submissionId: null,
    createdAt: occurredAt,
    resolvedAt: null,
    updatedAt: occurredAt,
  };
  const harness = createHarness(undefined, 0, false, [request]);
  await harness.controller.start();
  const state = harness.controller.getState();
  assert(state.planImplementationRequests.length === 1 && state.planImplementationRequests[0]?.id === request.id, 'Snapshot V2 hydration must restore the pending plan confirmation card.');
  assert(harness.connectedAfterSequences.length === 1, 'A pending plan confirmation must keep realtime synchronization active.');
  harness.controller.dispose();
  return {
    restoredRequestId: request.id,
    waitReason: state.queue?.waitReason,
    realtimeConnections: harness.connectedAfterSequences.length,
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
      syncStreamGeneration: 'zeus-conversation-sync-v2',
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
    syncStreamGeneration: 'zeus-conversation-sync-v2',
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
  processPageTerminalPreservation: verifyProcessPageDoesNotDowngradeLiveTerminalState(),
  queuedSubmissionThreadTransition: verifyQueuedSubmissionCanChangeNativeThread(),
  snapshotV2SettingsAndPlanRestoration: verifySnapshotV2SettingsAndPlanRestoration(),
  pendingPlanConfirmationRestoration: await verifyPendingPlanConfirmationRestoration(),
  idleHistoryWithoutSubscription: await verifyIdleHistoryDoesNotSubscribe(),
  restartedPendingSendReplay: await verifyRestartedPendingSendReplaysOnce(),
  activeSnapshotWatermarkSubscription: await verifyActiveSnapshotWatermarkSubscription(),
  idleTransitionReleasesSubscription: await verifyIdleTransitionReleasesSubscription(),
  renderDeltaOverflow: await verifyRenderDeltaOverflow(),
  syncGapByteOverflow: await verifyGapByteOverflow(),
  contiguousGapReplay: await verifyContiguousGapReplay(),
};

process.stdout.write(`${JSON.stringify(result)}\n`);
