import { describe, expect, it, vi } from 'vitest';
import { areRequiredRequestAnswersComplete, buildPendingRequestResponse, hasValidMcpResponsePayload, normalizeRequestQuestions, requestKind, supportedRequestDecisions } from '../src/renderer/session/PendingRequestSurface.js';
import { QUEUE_REORDER_THRESHOLD_PX, canSteerActiveTurn, moveQueueSubmissionByPixels, resolveComposerKeyIntent, saveQueuedSubmissionEdit, shouldCommitQueueReorder } from '../src/renderer/session/ConversationComposer.js';
import {
  buildStartNativeConversationRequest,
  createConnectedSessionActions,
  createNativeConversationStartEnvelopeManager,
  createProjectConversationStartEnvelopeManager,
  createRequestResponseGuard,
  loadLegacyConversationDetail,
  isRequestResponseBusy,
  nativeConversationChoiceFromAcceptance,
  projectConversationChoiceFromAcceptance,
  resolveComposerFocusRestoration,
  resolveSessionWorkspaceEscape,
  shouldRestoreComposerFocus,
  startNativeConversationWithDurableAcceptance,
  startProjectConversationWithDurableAcceptance,
  type ProjectSessionWorkspaceStartInput,
  type SessionWorkspaceStartInput,
} from '../src/renderer/session/SessionWorkspace.js';
import { createInitialSessionState } from '../src/renderer/session/sessionReducer.js';
import { createSessionEscapeController } from '../src/renderer/session/useThreadScrollController.js';
import { scheduleTurnPositionAfterSpacerCommit } from '../src/renderer/session/ConversationTranscript.js';
import { boundedMarkdownBlockText, boundedMarkdownText, itemRole } from '../src/renderer/session/ThreadItemView.js';
import type { NativeConversationChoice, NativePendingRequest, NativeQueuedSubmission, NativeSessionItemBuffer } from '../src/renderer/session/sessionTypes.js';
import type { SessionController } from '../src/renderer/session/useSessionController.js';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function startInput(content = 'Inspect the current task.'): SessionWorkspaceStartInput {
  return {
    mode: 'create',
    task: { id: 'task-1', projectId: 'project-1', title: 'Session parity' },
    content,
    permissionMode: 'auto',
  };
}

function projectStartInput(projectId = 'project-1', content = 'Inspect the current project.'): ProjectSessionWorkspaceStartInput {
  return {
    owner: { kind: 'project', projectId, projectName: `Project ${projectId}` },
    content,
    attachments: [],
    permissionMode: 'auto',
  };
}

function startChoice(overrides: Partial<NativeConversationChoice> = {}): NativeConversationChoice {
  return {
    id: 'conversation-1',
    projectId: 'project-1',
    taskId: 'task-1',
    title: 'Conversation',
    summary: null,
    status: 'active',
    transportKind: 'codex_native',
    providerId: 'codex',
    providerThreadId: 'thread-1',
    providerModel: 'gpt-5.4',
    providerState: 'ready',
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    archived: false,
    resumable: true,
    readOnly: false,
    ...overrides,
  };
}

function canonicalRuiPayload(questions: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'rui-item-1',
    questions,
    autoResolutionMs: null,
    ...overrides,
  };
}

function request(overrides: Partial<NativePendingRequest> = {}): NativePendingRequest {
  return {
    id: 'request-1',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    itemId: null,
    generationId: 'generation-1',
    type: 'request_user_input',
    status: 'pending',
    payload: canonicalRuiPayload([
      {
        id: 'choice',
        header: 'Choice',
        question: 'Choose one',
        options: [
          { label: 'A', description: 'First option' },
          { label: 'B', description: 'Second option' },
        ],
        isOther: false,
        isSecret: false,
      },
      { id: 'notes', header: 'Notes', question: 'Add notes', options: null, isOther: false, isSecret: false },
    ]),
    response: null,
    containsSecret: false,
    expiresAt: null,
    createdAt: '2026-07-13T00:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  };
}

describe('session interaction contract', () => {
  it('does not submit IME composition and reserves Shift+Enter for a newline', () => {
    expect(resolveComposerKeyIntent({ key: 'Enter', shiftKey: false, isComposing: true, repeat: false })).toBe('ignore');
    expect(resolveComposerKeyIntent({ key: 'Enter', shiftKey: true, isComposing: false, repeat: false })).toBe('newline');
    expect(resolveComposerKeyIntent({ key: 'Enter', shiftKey: false, isComposing: false, repeat: false })).toBe('submit');
    expect(resolveComposerKeyIntent({ key: 'Escape', shiftKey: false, isComposing: false, repeat: true })).toBe('ignore');
  });

  it('starts queue reordering only after the six pixel pointer threshold', () => {
    expect(QUEUE_REORDER_THRESHOLD_PX).toBe(6);
    expect(shouldCommitQueueReorder({ x: 10, y: 20 }, { x: 15, y: 20 })).toBe(false);
    expect(shouldCommitQueueReorder({ x: 10, y: 20 }, { x: 16, y: 20 })).toBe(true);
    expect(shouldCommitQueueReorder({ x: 10, y: 20 }, { x: 10, y: 26 })).toBe(true);
  });

  it('moves a dragged queue row across multiple positions and never outside the queue', () => {
    const queue = ['one', 'two', 'three', 'four'].map((id, position) => ({ id, content: id, status: 'queued', position, pausedReason: null }) satisfies NativeQueuedSubmission);

    expect(moveQueueSubmissionByPixels(queue, 'one', 88, 40)).toEqual(['two', 'three', 'one', 'four']);
    expect(moveQueueSubmissionByPixels(queue, 'four', -999, 40)).toEqual(['four', 'one', 'two', 'three']);
    expect(moveQueueSubmissionByPixels(queue, 'two', 0, 40)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('allows steer only for the exact started active turn', () => {
    const state = { ...createInitialSessionState(), transportState: 'ready' as const, conversationState: 'active_prework' as const, activeTurnId: 'turn-2', startedTurnId: 'turn-1' };
    expect(canSteerActiveTurn(state)).toBe(false);
    expect(canSteerActiveTurn({ ...state, startedTurnId: 'turn-2' })).toBe(true);
    expect(canSteerActiveTurn({ ...state, transportState: 'reconnecting' })).toBe(false);
  });

  it('normalizes RUI fields and emits the native request_user_input wire response', () => {
    const questions = normalizeRequestQuestions(request());
    expect(questions).toEqual([
      expect.objectContaining({ id: 'choice', kind: 'single', options: [expect.objectContaining({ label: 'A' }), expect.objectContaining({ label: 'B' })] }),
      expect.objectContaining({ id: 'notes', kind: 'freeform' }),
    ]);
    expect(buildPendingRequestResponse(request(), { choice: ['B'], notes: ['Keep the draft.'] })).toEqual({
      type: 'userInput',
      answers: { choice: { answers: ['B'] }, notes: { answers: ['Keep the draft.'] } },
    });
  });

  it('preserves RUI Other metadata and requires every question to have a real answer', () => {
    const rui = request({
      payload: canonicalRuiPayload([
        { id: 'choice', header: 'Choice', question: 'Choose one', options: [{ label: 'A', description: '' }], isOther: true, isSecret: false },
        { id: 'notes', header: 'Notes', question: 'Add notes', options: null, isOther: false, isSecret: false },
      ]),
    });
    const questions = normalizeRequestQuestions(rui);
    expect(questions[0]).toMatchObject({ allowOther: true });
    expect(areRequiredRequestAnswersComplete(questions, { choice: ['__other__'], notes: ['ready'] }, { choice: '' })).toBe(false);
    expect(areRequiredRequestAnswersComplete(questions, { choice: ['__other__'], notes: ['ready'] }, { choice: 'Custom answer' })).toBe(true);
    expect(buildPendingRequestResponse(rui, { choice: ['__other__'], notes: ['ready'] }, { choice: 'Custom answer' })).toEqual({
      type: 'userInput',
      answers: { choice: { answers: ['Custom answer'] }, notes: { answers: ['ready'] } },
    });
  });

  it('builds approval decisions with explicit type and blocks duplicate request responses', () => {
    const approval = request({ type: 'command', payload: { command: ['pwd'], availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['pwd'] } }, 'acceptForSession', 'decline', 'cancel', 'invented'] } });
    expect(buildPendingRequestResponse(approval, { decision: ['accept'] })).toEqual({ type: 'command', decision: 'accept' });
    expect(buildPendingRequestResponse(approval, { decision: ['decline'] })).toEqual({ type: 'command', decision: 'decline' });
    expect(buildPendingRequestResponse(approval, { decision: ['acceptForSession'] })).toEqual({ type: 'command', decision: 'acceptForSession' });
    expect(buildPendingRequestResponse(approval, { decision: ['cancel'] })).toEqual({ type: 'command', decision: 'cancel' });
    expect(supportedRequestDecisions(approval)).toEqual(['accept', 'acceptForSession', 'decline', 'cancel']);
    expect(buildPendingRequestResponse(request({ type: 'permissions', payload: { permissions: { network: { enabled: true } } } }), { decision: ['decline'] })).toEqual({ type: 'permissions', permissions: {}, scope: 'turn' });
    expect(
      buildPendingRequestResponse(
        request({
          type: 'mcp',
          payload: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            serverName: 'test',
            mode: 'form',
            message: 'Choose',
            requestedSchema: { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'] },
            _meta: null,
          },
        }),
        { decision: ['accept'], mcpContent: ['{"choice":"safe"}'] },
      ),
    ).toEqual({
      type: 'MCP',
      action: 'accept',
      content: { choice: 'safe' },
      _meta: null,
    });

    const guard = createRequestResponseGuard();
    expect(guard.begin('request-1')).toBe(true);
    expect(guard.begin('request-1')).toBe(false);
    guard.finish('request-1');
    expect(guard.begin('request-1')).toBe(true);
    expect(isRequestResponseBusy('request:respond:request-1:{"decision":"accept"}', 'request-1')).toBe(true);
    expect(isRequestResponseBusy('request:respond:request-1', 'request-1')).toBe(true);
    expect(isRequestResponseBusy('request:respond:request-10:{"decision":"accept"}', 'request-1')).toBe(false);
  });

  it('restores composer focus only after the final pending request is gone', () => {
    const ready = { ...createInitialSessionState(), transportState: 'ready' as const };
    expect(shouldRestoreComposerFocus(2, 1, ready)).toBe(false);
    expect(shouldRestoreComposerFocus(1, 0, ready)).toBe(true);
    expect(shouldRestoreComposerFocus(1, 0, { ...ready, transportState: 'reconnecting' })).toBe(false);
    expect(shouldRestoreComposerFocus(1, 0, { ...ready, error: { message: 'recover', code: null, recoveryRequired: true, retryable: false } })).toBe(false);
    expect(shouldRestoreComposerFocus(1, 0, { ...ready, conversationState: 'waiting_user_input', busyOperation: 'request:respond:request-1' })).toBe(false);

    const delayed = resolveComposerFocusRestoration({ previousPendingCount: 1, pendingCount: 0, restorationPending: false, state: { ...ready, conversationState: 'waiting_user_input' }, readOnly: false });
    expect(delayed).toEqual({ restorationPending: true, shouldFocus: false });
    expect(resolveComposerFocusRestoration({ previousPendingCount: 0, pendingCount: 0, restorationPending: delayed.restorationPending, state: ready, readOnly: false })).toEqual({ restorationPending: false, shouldFocus: true });
  });

  it('fails closed for unknown request kinds and malformed MCP JSON payloads', () => {
    const unknown = request({ type: 'provider/surprise', payload: { availableDecisions: ['accept'] } });
    expect(requestKind(unknown)).toBe('unknown');
    expect(supportedRequestDecisions(unknown)).toEqual([]);
    expect(() => buildPendingRequestResponse(unknown, { decision: ['accept'] })).toThrow('Unsupported pending request type');
    expect(() => buildPendingRequestResponse(request({ type: 'command', payload: { availableDecisions: ['cancel'] } }), { decision: ['accept'] })).toThrow('The requested decision is not safely available');

    const invalidMcp = request({ type: 'MCP', payload: { content: { bad: Number.NaN }, _meta: { source: 'server' }, availableDecisions: ['accept', 'decline'] } });
    expect(hasValidMcpResponsePayload(invalidMcp)).toBe(false);
    expect(supportedRequestDecisions(invalidMcp)).toEqual(['decline', 'cancel']);
    const validMcp = request({
      type: 'MCP',
      payload: { threadId: 'thread-1', turnId: null, serverName: 'oauth', mode: 'url', message: 'Authorize', url: 'https://example.com/authorize', elicitationId: 'elicitation-1', _meta: null },
    });
    expect(hasValidMcpResponsePayload(validMcp)).toBe(true);
    expect(buildPendingRequestResponse(validMcp, { decision: ['accept'] })).toEqual({ type: 'MCP', action: 'accept', content: null, _meta: null });
  });

  it('classifies provider item types explicitly and bounds untrusted markdown input', () => {
    const base = {
      key: 'key',
      conversationId: 'conversation-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      status: 'completed',
      phase: 'final_answer',
      text: '',
      payload: {},
    } satisfies NativeSessionItemBuffer;
    expect(itemRole({ ...base, type: 'fileChange' })).toBe('file');
    expect(itemRole({ ...base, type: 'commandExecution' })).toBe('tool');
    expect(itemRole({ ...base, type: 'mcpToolCall' })).toBe('tool');
    expect(itemRole({ ...base, type: 'providerMystery' })).toBe('unknown');
    expect(itemRole({ ...base, type: 'providerMystery', phase: 'prework', text: 'opaque progress' })).toBe('unknown');
    expect(boundedMarkdownText('x'.repeat(250_000))).toMatchObject({ truncated: true, text: expect.stringMatching(/\[content truncated\]$/) });
    expect(boundedMarkdownBlockText('x'.repeat(60_000))).toMatchObject({ truncated: true, text: expect.stringMatching(/\[block truncated\]$/) });
  });

  it('persists the native start envelope before dispatch and reuses its ids after controller rebuild', () => {
    const storage = new MemoryStorage();
    const generated = ['idempotency-1', 'message-1', 'idempotency-should-not-run', 'message-should-not-run'];
    const first = createNativeConversationStartEnvelopeManager({ storage, createId: () => generated.shift()! });
    const request = first.prepare(startInput());

    expect(storage.values.size).toBe(1);
    expect(request).toEqual({ mode: 'create', permissionMode: 'auto', content: 'Inspect the current task.', idempotencyKey: 'idempotency-1', clientUserMessageId: 'message-1' });

    const rebuilt = createNativeConversationStartEnvelopeManager({ storage, createId: () => generated.shift()! });
    expect(rebuilt.prepare(startInput())).toEqual(request);
    expect(generated).toEqual(['idempotency-should-not-run', 'message-should-not-run']);
  });

  it('rotates native start ids only when the fingerprint changes and clears after durable acceptance', () => {
    const storage = new MemoryStorage();
    let nextId = 0;
    const manager = createNativeConversationStartEnvelopeManager({ storage, createId: () => `generated-${++nextId}` });
    const first = manager.prepare(startInput('First content'));
    const changed = manager.prepare(startInput('Changed content'));

    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(changed.clientUserMessageId).not.toBe(first.clientUserMessageId);
    expect(manager.clearAccepted(startInput('Changed content'), changed, { operation: { id: 'operation-1', status: 'accepted', idempotencyKey: changed.idempotencyKey }, conversation: { id: 'conversation-1' } })).toBe(true);
    expect(storage.values.size).toBe(0);

    const afterAcceptance = manager.prepare(startInput('Changed content'));
    expect(afterAcceptance.idempotencyKey).not.toBe(changed.idempotencyKey);
  });

  it('persists project starts under project-scoped envelopes and never reuses ids across projects', () => {
    const storage = new MemoryStorage();
    let nextId = 0;
    const manager = createProjectConversationStartEnvelopeManager({ storage, createId: () => `project-id-${++nextId}` });
    const projectOne = manager.prepare(projectStartInput('project-1'));
    const projectOneRetry = manager.prepare(projectStartInput('project-1'));
    const projectTwo = manager.prepare(projectStartInput('project-2'));

    expect(projectOneRetry).toEqual(projectOne);
    expect(projectTwo.idempotencyKey).not.toBe(projectOne.idempotencyKey);
    expect([...storage.values.keys()]).toEqual(expect.arrayContaining(['zeus.project-conversation-start:v1:project-1', 'zeus.project-conversation-start:v1:project-2']));
  });

  it('materializes and navigates a taskless project acceptance before best-effort choices refresh', async () => {
    const storage = new MemoryStorage();
    const envelopeManager = createProjectConversationStartEnvelopeManager({ storage, createId: vi.fn().mockReturnValueOnce('project-idem').mockReturnValueOnce('project-message') });
    const order: string[] = [];
    const result = await startProjectConversationWithDurableAcceptance({
      input: projectStartInput('project-real', '自由项目消息'),
      envelopeManager,
      dispatch: async (projectId, request) => {
        order.push(`post:${projectId}:${request.idempotencyKey}`);
        return {
          operation: { id: 'operation-project', status: 'accepted', idempotencyKey: request.idempotencyKey },
          conversation: { id: 'conversation-project', projectId, taskId: null, title: '自由项目消息' },
          submission: { id: 'submission-project' },
        };
      },
      onAccepted: (choice) => order.push(`navigate:${choice.id}:${String(choice.taskId)}`),
      refresh: async (projectId) => {
        order.push(`refresh:${projectId}`);
        throw new Error('best-effort refresh failed');
      },
    });

    expect(order).toEqual(['post:project-real:project-idem', 'navigate:conversation-project:null', 'refresh:project-real']);
    expect(result.choice).toMatchObject({ projectId: 'project-real', taskId: null, title: '自由项目消息' });
    expect(result.refreshError).toBeInstanceOf(Error);
    expect(storage.values.size).toBe(0);
  });

  it('forces project acceptance choices to remain taskless even when a malformed fallback contains a task id', () => {
    const choice = projectConversationChoiceFromAcceptance(
      { operation: { id: 'operation-project', status: 'accepted', idempotencyKey: 'project-key' }, conversation: { id: 'conversation-project', projectId: 'project-1', taskId: 'must-not-bind' } },
      projectStartInput().owner,
      '2026-07-17T00:00:00.000Z',
    );
    expect(choice.taskId).toBeNull();
  });

  it('materializes a durable accepted conversation before any history refresh can fail', () => {
    const choice = nativeConversationChoiceFromAcceptance(
      {
        operation: { id: 'operation-1', status: 'accepted', idempotencyKey: 'idempotency-1' },
        conversation: { id: 'conversation-new', title: 'Accepted immediately', providerThreadId: 'thread-new', transportKind: 'codex_native' },
      },
      startInput().task,
      '2026-07-13T12:00:00.000Z',
    );
    expect(choice).toMatchObject({ id: 'conversation-new', taskId: 'task-1', projectId: 'project-1', providerThreadId: 'thread-new', resumable: true, readOnly: false });
  });

  it('navigates to the exact durable accepted id before a failing choices refresh and never reposts', async () => {
    const storage = new MemoryStorage();
    const envelopeManager = createNativeConversationStartEnvelopeManager({ storage, createId: vi.fn().mockReturnValueOnce('idem-1').mockReturnValueOnce('message-1') });
    const order: string[] = [];
    const dispatch = vi.fn(async (_taskId: string, requestBody: { idempotencyKey: string }) => {
      order.push(`post:${requestBody.idempotencyKey}`);
      return { operation: { id: 'operation-1', status: 'accepted', idempotencyKey: requestBody.idempotencyKey }, conversation: { id: 'conversation-exact' } };
    });
    const result = await startNativeConversationWithDurableAcceptance({
      input: startInput('Create once'),
      envelopeManager,
      dispatch,
      onAccepted: (choice) => order.push(`navigate:${choice.id}`),
      refresh: async () => {
        order.push('refresh');
        throw new Error('summary refresh failed');
      },
    });
    expect(order).toEqual(['post:idem-1', 'navigate:conversation-exact', 'refresh']);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ choice: { id: 'conversation-exact' }, refreshResult: null, refreshError: expect.any(Error) });
    expect(storage.values.size).toBe(0);
  });

  it('retries a failed start with the exact same request body and ids', async () => {
    const storage = new MemoryStorage();
    let nextId = 0;
    const manager = createNativeConversationStartEnvelopeManager({ storage, createId: () => `retry-${++nextId}` });
    const dispatch = vi.fn(async () => {
      throw new Error('response lost');
    });
    const first = manager.prepare(startInput('Stable retry content'));
    await expect(dispatch(first)).rejects.toThrow('response lost');
    const retry = manager.prepare(startInput('Stable retry content'));

    expect(retry).toEqual(first);
    expect(dispatch).toHaveBeenCalledWith(first);
    expect(nextId).toBe(2);
  });

  it('builds explicit create, resume, and legacy-reference start payloads', () => {
    let id = 0;
    const createId = () => `id-${++id}`;
    expect(buildStartNativeConversationRequest(startInput(' Create '), createId)).toEqual({ mode: 'create', permissionMode: 'auto', content: 'Create', idempotencyKey: 'id-1', clientUserMessageId: 'id-2' });
    expect(buildStartNativeConversationRequest({ ...startInput('Resume'), mode: 'resume', conversation: startChoice() }, createId)).toEqual({
      mode: 'resume',
      conversationId: 'conversation-1',
      content: 'Resume',
      idempotencyKey: 'id-3',
      clientUserMessageId: 'id-4',
    });
    expect(
      buildStartNativeConversationRequest(
        {
          ...startInput('Reference'),
          mode: 'reference_legacy',
          conversation: startChoice({ id: 'legacy-choice', transportKind: 'legacy_cli', legacySourceConversationId: 'legacy-source', resumable: false, readOnly: true }),
          legacyMessageIds: ['message-2', 'message-1', 'message-2'],
        },
        createId,
      ),
    ).toEqual({ mode: 'reference_legacy', permissionMode: 'auto', sourceConversationId: 'legacy-source', messageIds: ['message-2', 'message-1'], content: 'Reference', idempotencyKey: 'id-5', clientUserMessageId: 'id-6' });
  });

  it('maps workspace actions to the single session controller without bypassing it', async () => {
    const controller = {
      reconnect: vi.fn(async () => undefined),
      setDraft: vi.fn(),
      setAttachments: vi.fn(),
      send: vi.fn(async () => ({ operation: { status: 'accepted' }, conversation: { id: 'conversation-1' } })),
      interruptActiveTurn: vi.fn(async () => ({ operation: { status: 'accepted' }, conversation: { id: 'conversation-1' } })),
      editQueuedSubmission: vi.fn(async () => ({ state: { type: 'idle' }, submissions: [] })),
      deleteQueuedSubmission: vi.fn(async () => ({ state: { type: 'idle' }, submissions: [] })),
      sendQueuedNow: vi.fn(async () => ({ operation: { status: 'accepted' }, conversation: { id: 'conversation-1' } })),
      reorderQueue: vi.fn(async () => ({ state: { type: 'idle' }, submissions: [] })),
      resumeQueue: vi.fn(async () => ({ state: { type: 'idle' }, submissions: [] })),
      respondToRequest: vi.fn(async () => ({ operation: { status: 'responded' }, request: request({ status: 'resolved' }) })),
      setPermissionMode: vi.fn(async () => ({ id: 'conversation-1', permissionMode: 'full-access' })),
    } as unknown as SessionController;
    const attachment = { name: 'note.txt', mime: 'text/plain', size: 4, localPath: '/project/note.txt' } as const;
    const state = { ...createInitialSessionState(), transportState: 'ready' as const, conversationState: 'active_prework' as const, attachments: [], activeTurnId: 'turn-1', startedTurnId: 'turn-1' };
    const actions = createConnectedSessionActions({ controller, state, onChooseAttachments: async () => [attachment] });

    await actions.onSubmit?.('queue');
    await actions.onSubmit?.('steer_now');
    await actions.onInterrupt?.('turn-1');
    await actions.onEditQueuedSubmission?.('queued-1', 'edited');
    await actions.onDeleteQueuedSubmission?.('queued-1');
    await actions.onSendQueuedNow?.('queued-1');
    await actions.onReorderQueue?.(['queued-2', 'queued-1']);
    await actions.onResumeQueue?.();
    await actions.onChooseAttachments?.();
    await actions.onRespondToRequest?.('request-1', { type: 'userInput', answers: {} });
    await actions.onPermissionModeChange?.('full-access');

    expect(controller.send).toHaveBeenNthCalledWith(1, 'queue', undefined);
    expect(controller.send).toHaveBeenNthCalledWith(2, 'steer_now', 'turn-1');
    expect(controller.interruptActiveTurn).toHaveBeenCalledOnce();
    expect(controller.setAttachments).toHaveBeenCalledWith([attachment]);
    expect(controller.respondToRequest).toHaveBeenCalledWith('request-1', { type: 'userInput', answers: {} });
    expect(controller.setPermissionMode).toHaveBeenCalledWith('full-access');
  });

  it('keeps connected workspace operations fail-closed when recovery is required', async () => {
    const controller = {
      reconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ operation: { status: 'accepted' }, conversation: { id: 'conversation-1' } })),
      interruptActiveTurn: vi.fn(async () => ({ operation: { status: 'accepted' }, conversation: { id: 'conversation-1' } })),
      editQueuedSubmission: vi.fn(async () => ({ state: { type: 'idle' }, submissions: [] })),
      deleteQueuedSubmission: vi.fn(async () => ({ state: { type: 'idle' }, submissions: [] })),
      sendQueuedNow: vi.fn(async () => ({ operation: { status: 'accepted' }, conversation: { id: 'conversation-1' } })),
      reorderQueue: vi.fn(async () => ({ state: { type: 'idle' }, submissions: [] })),
      resumeQueue: vi.fn(async () => ({ state: { type: 'idle' }, submissions: [] })),
      respondToRequest: vi.fn(async () => ({ operation: { status: 'responded' }, request: request({ status: 'resolved' }) })),
      setDraft: vi.fn(),
      setAttachments: vi.fn(),
      setPermissionMode: vi.fn(async () => ({ id: 'conversation-1', permissionMode: 'auto' })),
    } as unknown as SessionController;
    const state = {
      ...createInitialSessionState(),
      transportState: 'failed' as const,
      conversationState: 'turn_failed' as const,
      activeTurnId: 'turn-1',
      startedTurnId: 'turn-1',
      error: { message: 'Recovery required', code: 'RECOVERY_REQUIRED', recoveryRequired: true, retryable: false },
    };
    const actions = createConnectedSessionActions({ controller, state });
    await actions.onReconnect?.();
    await actions.onSubmit?.('queue');
    await actions.onInterrupt?.('turn-1');
    await actions.onEditQueuedSubmission?.('queued-1', 'edited');
    await actions.onDeleteQueuedSubmission?.('queued-1');
    await actions.onSendQueuedNow?.('queued-1');
    await actions.onReorderQueue?.(['queued-2', 'queued-1']);
    await actions.onResumeQueue?.();
    await actions.onRespondToRequest?.('request-1', { type: 'decline' });
    await actions.onPermissionModeChange?.('auto');
    expect(controller.reconnect).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
    expect(controller.interruptActiveTurn).not.toHaveBeenCalled();
    expect(controller.editQueuedSubmission).not.toHaveBeenCalled();
    expect(controller.deleteQueuedSubmission).not.toHaveBeenCalled();
    expect(controller.sendQueuedNow).not.toHaveBeenCalled();
    expect(controller.reorderQueue).not.toHaveBeenCalled();
    expect(controller.resumeQueue).not.toHaveBeenCalled();
    expect(controller.respondToRequest).not.toHaveBeenCalled();
    expect(controller.setPermissionMode).not.toHaveBeenCalled();
  });

  it('requires two non-repeated Escape presses before interrupting the matching started turn', () => {
    const controller = createSessionEscapeController();
    const input = { repeat: false, openLayers: [], inputFocused: true, responding: true, activeTurnId: 'turn-1', startedTurnId: 'turn-1', now: 1_000 } as const;
    expect(controller.handleEscape(input)).toMatchObject({ action: 'confirm_interrupt' });
    expect(controller.handleEscape({ ...input, repeat: true, now: 1_100 })).toMatchObject({ action: 'none' });
    expect(controller.handleEscape({ ...input, now: 1_200 })).toEqual({ consumed: true, action: 'interrupt', turnId: 'turn-1' });
  });

  it('prioritizes a pending request over interrupt and expires the two-second interrupt arm', () => {
    const controller = createSessionEscapeController();
    const base = { repeat: false, inputFocused: true, responding: true, activeTurnId: 'turn-1', startedTurnId: 'turn-1' } as const;
    expect(controller.handleEscape({ ...base, openLayers: ['approval'], now: 1_000 })).toEqual({ consumed: true, action: 'close_approval' });
    expect(controller.handleEscape({ ...base, openLayers: [], now: 1_100 })).toMatchObject({ action: 'confirm_interrupt' });
    expect(controller.handleEscape({ ...base, openLayers: [], now: 3_101 })).toMatchObject({ action: 'confirm_interrupt' });
  });

  it('only arms an interrupt when Escape originates from the focused composer textarea', () => {
    const controller = createSessionEscapeController();
    const composerTextarea = {};
    const unrelatedControl = {};
    const base = {
      controller,
      composerTextarea,
      repeat: false,
      openLayers: [],
      responding: true,
      activeTurnId: 'turn-1',
      startedTurnId: 'turn-1',
    } as const;

    expect(resolveSessionWorkspaceEscape({ ...base, eventTarget: unrelatedControl, now: 1_000 })).toEqual({ consumed: false, action: 'none' });
    expect(resolveSessionWorkspaceEscape({ ...base, eventTarget: unrelatedControl, now: 1_100 })).toEqual({ consumed: false, action: 'none' });
    expect(resolveSessionWorkspaceEscape({ ...base, eventTarget: composerTextarea, now: 1_200 })).toMatchObject({ action: 'confirm_interrupt' });
    expect(resolveSessionWorkspaceEscape({ ...base, eventTarget: unrelatedControl, openLayers: ['approval'], now: 1_300 })).toEqual({ consumed: true, action: 'close_approval' });
  });

  it('keeps a queue edit open on failed persistence and closes only after success', async () => {
    const failedSave = vi.fn(async () => {
      throw new Error('write failed');
    });
    const successfulSave = vi.fn(async () => undefined);

    await expect(saveQueuedSubmissionEdit('queued-1', 'preserve me', failedSave)).resolves.toBe(false);
    await expect(saveQueuedSubmissionEdit('queued-1', 'save me', successfulSave)).resolves.toBe(true);
    expect(failedSave).toHaveBeenCalledWith('queued-1', 'preserve me');
    expect(successfulSave).toHaveBeenCalledWith('queued-1', 'save me');
  });

  it('loads a directly selected legacy choice by its explicit source conversation id', async () => {
    const load = vi.fn(async () => ({ messages: [{ id: 'message-1' }] }));
    const result = await loadLegacyConversationDetail(startChoice({ id: 'legacy-choice', transportKind: 'legacy_cli', legacySourceConversationId: 'legacy-source', readOnly: true, resumable: false }), load);

    expect(load).toHaveBeenCalledWith('project-1', 'legacy-source');
    expect(result).toEqual({ sourceConversationId: 'legacy-source', detail: { messages: [{ id: 'message-1' }] } });
  });

  it('reads DOM scrollHeight only after the committed turn spacer frame', () => {
    let scheduled: FrameRequestCallback | undefined;
    const container = { scrollHeight: 420, scrollTo: vi.fn() };
    scheduleTurnPositionAfterSpacerCommit(
      container,
      (callback) => {
        scheduled = callback;
        return 1;
      },
      () => true,
    );

    container.scrollHeight = 960;
    scheduled?.(16);
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 960, behavior: 'auto' });
  });
});
