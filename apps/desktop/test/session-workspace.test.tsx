import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInitialSessionState } from '../src/renderer/session/sessionReducer.js';
import { ConversationComposer, resolveComposerKeyIntent } from '../src/renderer/session/ConversationComposer.js';
import { PermissionModeControl, requiresPermissionModeConfirmation } from '../src/renderer/session/PermissionModeControl.js';
import { ConversationTranscript, anchorPendingRequests, resolveCompletedItemAnnouncement } from '../src/renderer/session/ConversationTranscript.js';
import { PendingRequestSurface } from '../src/renderer/session/PendingRequestSurface.js';
import { ProjectConversationTree, conversationTreeRuntimeStateFromSession, type ProjectConversationGroup } from '../src/renderer/session/ProjectConversationTree.js';
import { SessionWorkspace, createSessionHeaderSnapshot } from '../src/renderer/session/SessionWorkspace.js';
import { MAX_MARKDOWN_BLOCKS, MAX_MARKDOWN_NODES, ThreadItemView } from '../src/renderer/session/ThreadItemView.js';
import type { NativeConversationChoice, NativePendingRequest, NativeSessionItemBuffer, NativeSessionState } from '../src/renderer/session/sessionTypes.js';

function conversation(overrides: Partial<NativeConversationChoice> = {}): NativeConversationChoice {
  return {
    id: 'conversation-native-1',
    projectId: 'project-1',
    taskId: 'task-1',
    title: 'Native conversation one',
    summary: 'Real Codex app-server thread',
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

function item(overrides: Partial<NativeSessionItemBuffer> = {}): NativeSessionItemBuffer {
  return {
    key: 'conversation-native-1/thread-1/turn-1/item-1',
    conversationId: 'conversation-native-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    type: 'assistant_message',
    status: 'completed',
    phase: 'final_answer',
    text: '## Result\n\n- native answer\n- [source](https://example.com)\n\n`pnpm test`',
    payload: {},
    ...overrides,
  };
}

function request(overrides: Partial<NativePendingRequest> = {}): NativePendingRequest {
  return {
    id: 'request-1',
    conversationId: 'conversation-native-1',
    turnId: 'turn-local-1',
    itemId: null,
    generationId: 'generation-1',
    type: 'command',
    status: 'pending',
    payload: { command: ['/bin/pwd'], reason: 'Read the selected project directory.' },
    response: null,
    containsSecret: false,
    expiresAt: null,
    createdAt: '2026-07-13T00:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  };
}

function sessionState(overrides: Partial<NativeSessionState> = {}): NativeSessionState {
  const base = createInitialSessionState();
  const transcriptItem = item();
  return {
    ...base,
    transportState: 'ready',
    conversationState: 'native_idle',
    projectId: 'project-1',
    conversationId: 'conversation-native-1',
    providerThreadId: 'thread-1',
    items: { [transcriptItem.key]: transcriptItem },
    itemOrder: [transcriptItem.key],
    queue: { state: { type: 'idle' }, submissions: [] },
    draft: '',
    attachments: [],
    ...overrides,
  };
}

const projectGroups: ProjectConversationGroup[] = [
  {
    projectId: 'project-1',
    projectName: 'Zeus',
    tasks: [
      {
        taskId: 'task-1',
        taskTitle: 'App-server parity',
        conversations: [conversation(), conversation({ id: 'conversation-native-2', title: 'Native conversation two', providerThreadId: 'thread-2' })],
      },
    ],
  },
];

describe('Codex parity session workspace', () => {
  it('renders a project-scoped bottom composer without the obsolete task picker copy', () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace
        language="en-US"
        state={null}
        conversation={null}
        owner={{ kind: 'project', projectId: 'project-1', projectName: 'Zeus' }}
        task={null}
        tasks={[
          { id: 'task-1', projectId: 'project-1', title: 'Task one' },
          { id: 'task-2', projectId: 'project-1', title: 'Task two' },
        ]}
        autoFocusNewConversation
      />,
    );

    expect(html).toContain('aria-label="Conversation workspace"');
    expect(html).toContain('class="session-new-conversation"');
    expect(html).toContain('class="session-composer-shell session-new-conversation-composer"');
    expect(html).toMatch(/<textarea[^>]*autoFocus=""|<textarea[^>]*autofocus=""/i);
    expect(html).not.toContain('Select a real task first');
    expect(html).not.toContain('native app-server');
    expect(html).not.toContain('Select the task to bind');
    expect(html).not.toContain('session-start-empty');
    expect(html).not.toContain('session-start-task-picker');
    expect(html).not.toContain('Task one');
    expect(html).not.toContain('Task two');
  });

  it('uses Codex keyboard semantics for the new-conversation composer', () => {
    expect(resolveComposerKeyIntent({ key: 'Enter', shiftKey: false, isComposing: false, repeat: false })).toBe('submit');
    expect(resolveComposerKeyIntent({ key: 'Enter', shiftKey: true, isComposing: false, repeat: false })).toBe('newline');
    expect(resolveComposerKeyIntent({ key: 'Enter', shiftKey: false, isComposing: true, repeat: false })).toBe('ignore');
  });

  it('renders project conversations directly instead of inventing a task group', () => {
    const projectConversation = conversation({ id: 'project-conversation', taskId: null, title: '自由项目对话', summary: '直接挂在项目下' });
    const html = renderToStaticMarkup(
      <ProjectConversationTree
        groups={[{ projectId: 'project-1', projectName: 'Zeus', conversations: [projectConversation], tasks: [] }]}
        selectedConversationId="project-conversation"
        onSelectConversation={() => undefined}
        onStartConversation={() => undefined}
        language="zh-CN"
      />,
    );

    expect(html).toContain('自由项目对话');
    expect(html).toContain('直接挂在项目下');
    expect(html.match(/data-conversation-tree-item="true"/g)).toHaveLength(1);
    expect(html).not.toContain('session-conversation-task-group');
  });

  it('omits visible user and Codex role names while preserving accessible ownership and delivery state', () => {
    for (const language of ['en-US', 'zh-CN'] as const) {
      const userHtml = renderToStaticMarkup(<ThreadItemView language={language} item={item({ type: 'userMessage', text: 'Question' })} />);
      const optimisticUserHtml = renderToStaticMarkup(<ThreadItemView language={language} item={item({ type: 'userMessage', text: 'Question', optimistic: true })} />);
      const assistantHtml = renderToStaticMarkup(<ThreadItemView language={language} item={item({ type: 'assistantMessage', text: 'Answer' })} />);
      const commentaryHtml = renderToStaticMarkup(<ThreadItemView language={language} item={item({ type: 'reasoning', phase: 'analysis', text: 'Working' })} />);

      expect(userHtml).toContain(`aria-label="${language === 'zh-CN' ? '你' : 'You'}"`);
      expect(assistantHtml).toContain('aria-label="Codex"');
      expect(commentaryHtml).toContain('aria-label="Codex"');
      expect(userHtml).not.toContain('class="session-thread-item-meta"');
      expect(assistantHtml).not.toContain('class="session-thread-item-meta"');
      expect(commentaryHtml).not.toContain('class="session-thread-item-meta"');
      expect(optimisticUserHtml).toContain(`<span class="session-item-state">${language === 'zh-CN' ? '发送中' : 'Sending'}</span>`);
      expect(optimisticUserHtml).not.toContain(`<strong>${language === 'zh-CN' ? '你' : 'You'}</strong>`);
    }
  });

  it('keeps non-conversational provider category labels visible in both languages', () => {
    const labelledItems = [
      { type: 'mcpToolCall', labels: { 'en-US': 'Tool call', 'zh-CN': '工具调用' } },
      { type: 'fileChange', labels: { 'en-US': 'File change', 'zh-CN': '文件变更' } },
      { type: 'commandApproval', labels: { 'en-US': 'Action pending', 'zh-CN': '等待操作' } },
      { type: 'error', labels: { 'en-US': 'Turn error', 'zh-CN': '本轮错误' } },
      { type: 'providerMystery', labels: { 'en-US': 'Unknown provider item', 'zh-CN': '未知 provider 项' } },
    ] as const;

    for (const language of ['en-US', 'zh-CN'] as const) {
      for (const labelledItem of labelledItems) {
        const html = renderToStaticMarkup(<ThreadItemView language={language} item={item({ type: labelledItem.type, text: 'Provider detail' })} />);
        expect(html).toContain(`<strong>${labelledItem.labels[language]}</strong>`);
      }
    }
  });

  it('uses one scoped workspace without an inner task rail, environment card, or fake voice control', () => {
    const html = renderToStaticMarkup(<SessionWorkspace language="en-US" state={sessionState()} conversation={conversation()} task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }} />);

    expect(html).toContain('session-workspace-root');
    expect(html).not.toContain('session-codex-parity-v1');
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="off"');
    expect(html).not.toContain('aria-relevant="additions text"');
    expect(html).not.toContain('conversation-list-pane');
    expect(html).not.toContain('Environment');
    expect(html).not.toContain('AI CLI');
    expect(html).not.toContain('Telegram');
    expect(html).not.toMatch(/voice|microphone/i);
  });

  it('anchors pending requests to their item or turn instead of a detached global stack', () => {
    const first = item({ key: 'first', itemId: 'item-1', turnId: 'turn-1', text: 'First' });
    const second = item({ key: 'second', itemId: 'item-2', turnId: 'turn-1', text: 'Second' });
    const direct = request({ id: 'direct', itemId: 'item-1', turnId: 'turn-1' });
    const turn = request({ id: 'turn', itemId: null, turnId: 'turn-1' });
    const tail = request({ id: 'tail', itemId: null, turnId: 'missing-turn' });
    expect(anchorPendingRequests([first, second], [direct, turn, tail])).toEqual({ afterItem: { first: ['direct'], second: ['turn'] }, tail: ['tail'] });
  });

  it('anchors direct requests by turn and item tuple and fails ambiguous naked item ids to the visible fallback', () => {
    const firstTurn = item({ key: 'turn-1/shared', itemId: 'shared-item', localItemId: 'shared-local', turnId: 'turn-1', text: 'First turn' });
    const secondTurn = item({ key: 'turn-2/shared', itemId: 'shared-item', localItemId: 'shared-local', turnId: 'turn-2', text: 'Second turn' });
    const firstRequest = request({ id: 'request-turn-1', itemId: 'shared-item', turnId: 'turn-1' });
    const secondRequest = request({ id: 'request-turn-2', itemId: 'shared-local', turnId: 'turn-2' });
    const ambiguousRequest = request({ id: 'request-ambiguous', itemId: 'shared-item', turnId: null });

    expect(anchorPendingRequests([firstTurn, secondTurn], [firstRequest, secondRequest, ambiguousRequest])).toEqual({
      afterItem: { 'turn-1/shared': ['request-turn-1'], 'turn-2/shared': ['request-turn-2'] },
      tail: ['request-ambiguous'],
    });
  });

  it('keeps an unmatched pending request id visible beside its transcript fallback surface', () => {
    const unmatched = request({ id: 'request-tail-opaque', itemId: 'missing-item', turnId: 'missing-turn' });
    const html = renderToStaticMarkup(<ConversationTranscript state={sessionState()} language="en-US" pendingRequests={[unmatched]} renderPendingRequest={() => <span>Approval fallback</span>} />);

    expect(html).toContain('session-pending-request-fallback-id');
    expect(html).toContain('Request ID');
    expect(html).toContain('request-tail-opaque');
    expect(html).toContain('Approval fallback');
  });

  it('announces the first completion after empty hydration and re-announces equal text under a new item key', () => {
    const emptyHydration = resolveCompletedItemAnnouncement({ hydrated: false, lastCompletedKey: null }, [], 'en-US');
    expect(emptyHydration.announcement).toBeNull();

    const first = item({ key: 'completed-1', text: 'Same final answer' });
    const firstCompletion = resolveCompletedItemAnnouncement(emptyHydration.tracker, [first], 'en-US');
    expect(firstCompletion.announcement).toEqual({ key: 'completed-1', text: 'New content completed: Same final answer' });

    const repeated = item({ key: 'completed-2', itemId: 'item-2', text: 'Same final answer' });
    const secondCompletion = resolveCompletedItemAnnouncement(firstCompletion.tracker, [first, repeated], 'en-US');
    expect(secondCompletion.announcement).toEqual({ key: 'completed-2', text: 'New content completed: Same final answer' });

    const existingHydration = resolveCompletedItemAnnouncement({ hydrated: false, lastCompletedKey: null }, [first], 'en-US');
    expect(existingHydration.announcement).toBeNull();
  });

  it('renders two independently selectable conversations under one task in the global source tree', () => {
    const html = renderToStaticMarkup(<ProjectConversationTree groups={projectGroups} selectedConversationId="conversation-native-2" onSelectConversation={() => undefined} onStartConversation={() => undefined} language="en-US" />);

    expect(html.match(/data-conversation-tree-item="true"/g)).toHaveLength(2);
    expect(html).toContain('Native conversation one');
    expect(html).toContain('Native conversation two');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('Thread ready');
    expect(html).not.toContain('role="listbox"');
  });

  it('gives the first real conversation the fallback roving tab stop when none is selected', () => {
    const html = renderToStaticMarkup(<ProjectConversationTree groups={projectGroups} selectedConversationId={null} onSelectConversation={() => undefined} onStartConversation={() => undefined} language="en-US" />);

    expect(html).toMatch(/Native conversation one[\s\S]*?tabindex="0"|tabindex="0"[\s\S]*?Native conversation one/);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(1);
  });

  it('maps the connected controller state into realtime source-tree status text', () => {
    expect(conversationTreeRuntimeStateFromSession(sessionState({ conversationState: 'active_prework' }))).toBe('streaming');
    expect(conversationTreeRuntimeStateFromSession(sessionState({ conversationState: 'waiting_user_input', pendingRequests: [request({ type: 'request_user_input' })] }))).toBe('pending_request');
    expect(conversationTreeRuntimeStateFromSession(sessionState({ transportState: 'failed' }))).toBe('error');
    expect(conversationTreeRuntimeStateFromSession(sessionState({ conversationState: 'native_idle' }))).toBe('ready');
    expect(conversationTreeRuntimeStateFromSession(sessionState({ transportState: 'connecting' }))).toBe('connecting');
    expect(conversationTreeRuntimeStateFromSession(sessionState({ transportState: 'hydrating' }))).toBe('connecting');
    expect(conversationTreeRuntimeStateFromSession(sessionState({ transportState: 'reconnecting' }))).toBe('reconnecting');
    expect(conversationTreeRuntimeStateFromSession(sessionState({ queue: { state: { type: 'paused', reason: 'interrupted' }, submissions: [] } }))).toBe('paused');
    expect(conversationTreeRuntimeStateFromSession(sessionState({ transportState: 'ready', error: { message: 'State may be incomplete.', code: 'RECOVERY_REQUIRED', recoveryRequired: true, retryable: false } }))).toBe('error');
  });

  it('shows persisted connecting and reconnecting provider summaries truthfully', () => {
    const html = renderToStaticMarkup(
      <ProjectConversationTree
        groups={[{ ...projectGroups[0]!, tasks: [{ ...projectGroups[0]!.tasks[0]!, conversations: [conversation({ id: 'connecting', providerState: 'connecting' }), conversation({ id: 'reconnecting', providerState: 'reconnecting' })] }] }]}
        onSelectConversation={() => undefined}
        onStartConversation={() => undefined}
        language="en-US"
      />,
    );
    expect(html).toContain('Connecting');
    expect(html).toContain('Reconnecting');
    expect(html).not.toContain('Thread ready');
  });

  it('fails closed when recovery is required and does not expose reconnect or a writable composer', () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace
        language="en-US"
        state={sessionState({ transportState: 'failed', error: { message: 'State may be incomplete.', code: 'RECOVERY_REQUIRED', recoveryRequired: true, retryable: true } })}
        conversation={conversation()}
        task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }}
        actions={{ onReconnect: () => undefined }}
      />,
    );
    expect(html).toContain('Recovery required');
    expect(html).toContain('Start a new conversation');
    expect(html).not.toContain('>Reconnect<');
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
  });

  it.each([
    ['loading', sessionState({ transportState: 'hydrating', itemOrder: [], items: {} }), 'Loading conversation'],
    ['reconnecting', sessionState({ transportState: 'reconnecting' }), 'Reconnecting'],
    ['idle', sessionState({ conversationState: 'native_idle' }), 'Ready'],
    ['prework', sessionState({ conversationState: 'active_prework' }), 'Working'],
    ['final answer', sessionState({ conversationState: 'active_final_answer' }), 'Answering'],
    ['approval', sessionState({ conversationState: 'waiting_approval', pendingRequests: [request()] }), 'Approval required'],
    [
      'request user input',
      sessionState({
        conversationState: 'waiting_user_input',
        pendingRequests: [
          request({
            id: 'request-rui',
            type: 'request_user_input',
            containsSecret: true,
            payload: { questions: [{ id: 'token', header: 'Token', question: 'Provide a temporary token', options: null, isOther: false, isSecret: true }] },
          }),
        ],
      }),
      'Input required',
    ],
    ['error', sessionState({ conversationState: 'turn_failed', error: { message: 'Provider failed safely.', code: 'PROVIDER_FAILED', recoveryRequired: false, retryable: false } }), 'Provider failed safely.'],
  ] as const)('renders the %s state as text rather than color alone', (_label, state, expected) => {
    const html = renderToStaticMarkup(<SessionWorkspace language="en-US" state={state} conversation={conversation()} task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }} />);
    expect(html).toContain(expected);
  });

  it('shows reconnect attempts and a distinct actionable server-busy failure with expandable details', () => {
    const reconnecting = renderToStaticMarkup(
      <SessionWorkspace language="en-US" state={sessionState({ transportState: 'reconnecting', reconnectAttempt: 3 })} conversation={conversation()} task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }} />,
    );
    const busy = renderToStaticMarkup(
      <SessionWorkspace
        language="en-US"
        state={sessionState({ transportState: 'failed', error: { message: 'Too many requests from provider.', code: 'RATE_LIMITED', recoveryRequired: false, retryable: true, status: 429 } })}
        conversation={conversation()}
        task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }}
        actions={{ onReconnect: () => undefined }}
      />,
    );

    expect(reconnecting).toContain('Reconnecting · attempt 3');
    expect(busy).toContain('Server busy');
    expect(busy).toContain('Wait briefly, then reconnect.');
    expect(busy).toContain('<details class="session-error-details"');
    expect(busy).toContain('<summary>Details</summary>');
    expect(busy).toContain('Too many requests from provider.');
    expect(busy).toContain('Reconnect');
  });

  it('renders settings, usage, rate limits, and MCP startup as compact accessible runtime details', () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace
        language="en-US"
        state={sessionState({
          providerSettings: { model: 'gpt-5.4', effort: 'high' },
          tokenUsage: { inputTokens: 10, outputTokens: 19, totalTokens: 29 },
          rateLimits: { value: { remaining: 0, resetAt: '12:00' } },
          mcpStartup: { value: { filesystem: { status: 'ready' } } },
        })}
        conversation={conversation()}
        task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }}
      />,
    );

    expect(html).toContain('class="session-runtime-details"');
    expect(html).toContain('data-severity="warning"');
    expect(html).toContain('gpt-5.4 · high');
    expect(html).toContain('29 tokens');
    expect(html).toContain('Remaining: 0');
    expect(html).toContain('Filesystem status: ready');
    expect(html).toContain('Attention required');
  });

  it('renders empty and legacy readonly start choices without implying a writable native thread', () => {
    const emptyHtml = renderToStaticMarkup(<SessionWorkspace language="en-US" state={null} conversation={null} task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }} choices={[]} />);
    const legacyHtml = renderToStaticMarkup(
      <SessionWorkspace
        language="en-US"
        state={null}
        conversation={conversation({ id: 'legacy-1', title: 'Legacy transcript', transportKind: 'legacy_cli', providerThreadId: null, resumable: false, readOnly: true })}
        task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }}
        actions={{ onOpenImportSettings: () => undefined }}
      />,
    );

    expect(emptyHtml).toContain('Send a message');
    expect(emptyHtml).toContain('session-new-conversation-composer');
    expect(legacyHtml).toContain('Legacy transcript is read-only');
    expect(legacyHtml).toContain('Import in Settings');
    expect(legacyHtml).not.toContain('aria-label="Send"');
  });

  it('renders legacy messages as a readonly transcript and makes a non-resumable native thread readonly', () => {
    const legacy = conversation({ id: 'legacy-1', transportKind: 'legacy_cli', providerThreadId: null, resumable: false, readOnly: true });
    const legacyHtml = renderToStaticMarkup(
      <SessionWorkspace
        language="en-US"
        state={null}
        conversation={legacy}
        task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }}
        legacyMessages={{
          'legacy-1': [
            { id: 'm1', role: 'user', content: 'Legacy question' },
            { id: 'm2', role: 'assistant', content: 'Legacy answer' },
          ],
        }}
      />,
    );
    const closedNativeHtml = renderToStaticMarkup(
      <SessionWorkspace language="en-US" state={sessionState()} conversation={conversation({ status: 'closed', resumable: false })} task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }} />,
    );
    expect(legacyHtml).toContain('Legacy question');
    expect(legacyHtml).toContain('Legacy answer');
    expect(legacyHtml).toContain('aria-label="Read-only legacy transcript"');
    expect(closedNativeHtml).toContain('This conversation can no longer be continued.');
    expect(closedNativeHtml).toMatch(/<textarea[^>]*disabled=""/);
  });

  it('creates a new conversation directly from the empty workspace even when history exists', () => {
    const html = renderToStaticMarkup(<SessionWorkspace language="en-US" state={null} conversation={null} task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }} choices={[conversation()]} />);
    expect(html).not.toContain('session-start-mode');
    expect(html).not.toContain('session-start-radio');
    expect(html).not.toContain('Resume this conversation');
    expect(html).toContain('Type a message. Enter to send, Shift+Enter for a newline.');
    expect(html).toMatch(/class="session-send-button"[^>]*disabled=""/);
  });

  it('does not render create, resume, or legacy-reference mode buttons', () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace
        language="en-US"
        state={null}
        conversation={null}
        task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }}
        choices={[conversation(), conversation({ id: 'legacy-1', transportKind: 'legacy_cli', resumable: false, readOnly: true })]}
      />,
    );

    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain('session-start-radio');
    expect(html).not.toContain('session-start-mode');
    expect(html).not.toContain('Resume this conversation');
    expect(html).not.toContain('Reference legacy conversation');
    expect(html).toContain('aria-label="Send a message"');
    expect(html).toContain('aria-label="Send"');
  });

  it('removes the obsolete session mode selectors from the scoped stylesheet', () => {
    const css = readFileSync(new URL('../src/renderer/session/session.css', import.meta.url), 'utf8');
    expect(css).not.toContain('.session-start-mode');
    expect(css).not.toContain('.session-start-radio');
  });

  it('projects empty reasoning out of the transcript and shows one truthful active-turn thinking row', () => {
    const user = item({ key: 'user-1', itemId: 'user-1', type: 'userMessage', turnId: 'message:user-1', text: 'Inspect the repository.' });
    const emptyReasoning = item({ key: 'reasoning-empty', itemId: 'reasoning-empty', type: 'reasoning', turnId: 'turn-1', status: 'in_progress', phase: 'prework', text: '', payload: { type: 'reasoning', summary: [], content: [] } });
    const state = sessionState({
      conversationState: 'active_prework',
      activeTurnId: 'turn-1',
      startedTurnId: 'turn-1',
      items: { [user.key]: user, [emptyReasoning.key]: emptyReasoning },
      itemOrder: [user.key, emptyReasoning.key],
    });

    const html = renderToStaticMarkup(<ConversationTranscript state={state} language="en-US" />);

    expect(html).toContain('class="session-transcript-thinking"');
    expect(html).toContain('Thinking');
    expect(html).not.toContain('data-item-type="reasoning"');
    expect(html).not.toContain('Work log');
  });

  it('replaces the synthetic thinking row as soon as a visible active-turn provider item exists', () => {
    const reasoning = item({ key: 'reasoning-visible', itemId: 'reasoning-visible', type: 'reasoning', turnId: 'turn-1', status: 'in_progress', phase: 'prework', text: 'Reading the real files.' });
    const state = sessionState({
      conversationState: 'active_prework',
      activeTurnId: 'turn-1',
      startedTurnId: 'turn-1',
      items: { [reasoning.key]: reasoning },
      itemOrder: [reasoning.key],
    });

    const html = renderToStaticMarkup(<ConversationTranscript state={state} language="en-US" />);

    expect(html).toContain('Reading the real files.');
    expect(html).not.toContain('session-transcript-thinking');
    expect(html).not.toContain('Work log');
  });

  it('renders a provider reasoning summary only when it contains real text', () => {
    const reasoning = item({ key: 'reasoning-summary', itemId: 'reasoning-summary', type: 'reasoning', text: '', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Indexing the selected project.' }], content: [] } });
    const state = sessionState({ items: { [reasoning.key]: reasoning }, itemOrder: [reasoning.key] });

    const html = renderToStaticMarkup(<ConversationTranscript state={state} language="en-US" />);

    expect(html).toContain('Indexing the selected project.');
    expect(html).toContain('Show work progress');
    expect(html).not.toContain('Work log');
  });

  it('keeps return-to-latest as a viewport overlay instead of a sticky transcript row', () => {
    const css = readFileSync(new URL('../src/renderer/session/session.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<ConversationTranscript state={sessionState()} language="en-US" />);

    expect(html).toContain('class="session-transcript-shell"');
    expect(css).toMatch(/\.session-codex-parity-v1 \.session-transcript-shell\s*\{[^}]*position:\s*relative/s);
    expect(css).toMatch(/\.session-codex-parity-v1 \.session-return-latest\s*\{[^}]*position:\s*absolute/s);
    expect(css).not.toMatch(/\.session-return-latest\s*\{[^}]*position:\s*sticky/s);
    expect(css).not.toContain('bottom: 118px');
  });

  it('keeps explicit new-conversation input available when choice history loading fails', () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace
        language="en-US"
        state={null}
        conversation={null}
        task={{ id: 'task-2', projectId: 'project-1', title: 'Task with unknown history' }}
        choices={[]}
        choicesKnown={false}
        loadState="error"
        loadError="Task choices are unavailable."
      />,
    );

    expect(html).toContain('Task choices are unavailable.');
    expect(html).not.toContain('session-start-mode');
    expect(html).toContain('session-new-conversation-composer');
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/);
  });

  it('keeps the native start form mounted after a failed attempt so the same durable envelope can be retried', () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace language="en-US" state={null} conversation={null} task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }} choices={[]} loadState="error" loadError="The response was lost; retry safely." />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('The response was lost; retry safely.');
    expect(html).toContain('session-composer-input-frame');
    expect(html).toContain('aria-label="Send"');
  });

  it('does not freeze explicit new input while a best-effort choices request is in flight', () => {
    const html = renderToStaticMarkup(<SessionWorkspace language="en-US" state={null} conversation={null} task={{ id: 'task-1', projectId: 'project-1', title: 'App-server parity' }} choices={[]} loadState="loading" />);

    expect(html).toContain('session-new-conversation-composer');
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/);
  });

  it('freezes text, attachments, permission, and send under one local submitting envelope', () => {
    const source = readFileSync(new URL('../src/renderer/session/SessionWorkspace.tsx', import.meta.url), 'utf8');
    const composer = source.slice(source.indexOf('function NewConversationComposer'), source.indexOf('function SessionLoading'));
    expect(composer).toContain('disabled={submitting || !props.owner}');
    expect(composer).toContain('disabled={submitting}');
    expect(composer).toContain('disabled={submitting || !props.owner || !content.trim()}');
    expect(composer).toContain('aria-busy={submitting || undefined}');
  });

  it('renders safe Markdown subset while escaping raw HTML and refusing javascript links', () => {
    const html = renderToStaticMarkup(<ThreadItemView language="en-US" item={item({ text: '## Safe\n\n<script>alert(1)</script>\n\n- item\n\n[bad](javascript:alert(1))\n\n[good](https://example.com)' })} isLatest />);

    expect(html).toContain('<h2>Safe</h2>');
    expect(html).toContain('<ul>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.com"');
  });

  it('renders h4, horizontal rules, emphasis, and a code copy action in the bounded Markdown subset', () => {
    const html = renderToStaticMarkup(<ThreadItemView language="en-US" item={item({ text: '#### Detail\n\n---\n\n*emphasis*\n\n```ts\nconst safe = true\n```' })} />);
    expect(html).toContain('<h4>Detail</h4>');
    expect(html).toContain('<hr/>');
    expect(html).toContain('<em>emphasis</em>');
    expect(html).toContain('aria-label="Copy code"');
  });

  it('localizes the Markdown code copy action for Chinese sessions', () => {
    const html = renderToStaticMarkup(<ThreadItemView language="zh-CN" item={item({ text: '```ts\nconst safe = true\n```' })} />);
    expect(html).toContain('aria-label="复制代码"');
    expect(html).not.toContain('Copy code');
  });

  it('caps Markdown block and node complexity with one explicit truncation marker', () => {
    const listHtml = renderToStaticMarkup(<ThreadItemView language="en-US" item={item({ text: Array.from({ length: 12_000 }, () => '- x').join('\n') })} />);
    const blockHtml = renderToStaticMarkup(<ThreadItemView language="en-US" item={item({ text: Array.from({ length: 2_000 }, () => 'x').join('\n\n') })} />);

    expect(listHtml.match(/<li>/g)?.length ?? 0).toBeLessThanOrEqual(MAX_MARKDOWN_NODES);
    expect(listHtml.match(/Content complexity truncated/g)).toHaveLength(1);
    expect(listHtml.length).toBeLessThan(500_000);
    expect(blockHtml.match(/<p>/g)?.length ?? 0).toBeLessThanOrEqual(MAX_MARKDOWN_BLOCKS + 1);
    expect(blockHtml.match(/Content complexity truncated/g)).toHaveLength(1);
  });

  it('creates an atomic header identity snapshot for title, task context, and status presence', () => {
    const oldHeader = createSessionHeaderSnapshot(
      conversation({ id: 'conversation-old', title: 'Old conversation' }),
      { id: 'task-old', projectId: 'project-1', title: 'Old task' },
      sessionState({ conversationState: 'active_prework' }),
      undefined,
      'en-US',
    );
    const nextHeader = createSessionHeaderSnapshot(
      conversation({ id: 'conversation-next', title: 'Next conversation' }),
      { id: 'task-next', projectId: 'project-1', title: 'Next task' },
      sessionState({ conversationState: 'waiting_user_input', pendingRequests: [request({ type: 'request_user_input' })] }),
      undefined,
      'en-US',
    );

    expect(oldHeader).toMatchObject({ conversationId: 'conversation-old', title: 'Old conversation', contextLabel: 'Old task', status: { label: 'Working' } });
    expect(nextHeader).toMatchObject({ conversationId: 'conversation-next', title: 'Next conversation', contextLabel: 'Next task', status: { label: 'Input required' } });
  });

  it('renders file and unknown provider items as typed facts rather than assistant prose', () => {
    const fileHtml = renderToStaticMarkup(
      <ThreadItemView language="en-US" item={item({ type: 'fileChange', text: '', payload: { path: 'src/App.tsx', action: 'updated', attachments: [{ name: 'patch.diff', mime: 'text/plain', status: 'ready' }] } })} />,
    );
    const unknownHtml = renderToStaticMarkup(<ThreadItemView language="en-US" item={item({ type: 'providerMystery', text: '', payload: { opaque: true } })} />);
    expect(fileHtml).toContain('aria-label="File change"');
    expect(fileHtml).toContain('<dt>Path</dt><dd>src/App.tsx</dd>');
    expect(fileHtml.match(/<dt>Action<\/dt>/g)).toHaveLength(1);
    expect(fileHtml).toContain('patch.diff');
    expect(unknownHtml).toContain('aria-label="Unknown provider item"');
    expect(unknownHtml).toContain('<dt>Provider type</dt><dd>providerMystery</dd>');
    expect(unknownHtml).not.toContain('aria-label="Codex"');
  });

  it('renders command executions as a compact typed row without dumping the raw provider payload', () => {
    const html = renderToStaticMarkup(
      <ThreadItemView
        language="en-US"
        item={item({
          type: 'commandExecution',
          text: '',
          payload: {
            command: ['/bin/zsh', '-lc', 'rg --files docs'],
            cwd: '/Users/david/hypha/zeus',
            status: 'completed',
            aggregatedOutput: 'docs/task.md\n',
            exitCode: 0,
            durationMs: 42,
            commandActions: [{ type: 'read' }],
          },
        })}
      />,
    );

    expect(html).toContain('class="session-command-item"');
    expect(html).toContain('/bin/zsh -lc rg --files docs');
    expect(html).toContain('/Users/david/hypha/zeus');
    expect(html).toContain('42 ms');
    expect(html).toContain('docs/task.md');
    expect(html).not.toContain('<strong>Tool call</strong>');
    expect(html).not.toContain('Technical details');
    expect(html).not.toContain('&quot;commandActions&quot;');
    expect(html).not.toContain('&quot;aggregatedOutput&quot;');
  });

  it('keeps send and stop in the same command slot and exposes queue controls without a fake retry', () => {
    const idle = renderToStaticMarkup(<ConversationComposer language="en-US" state={sessionState({ draft: 'Follow up' })} permissionMode="auto" onDraftChange={() => undefined} onSubmit={() => undefined} onInterrupt={() => undefined} />);
    const active = renderToStaticMarkup(
      <ConversationComposer
        language="en-US"
        state={sessionState({
          conversationState: 'active_prework',
          activeTurnId: 'turn-1',
          draft: 'Steer now',
          queue: {
            state: { type: 'active', turnId: 'turn-1', phase: 'prework' },
            submissions: [{ id: 'queued-1', content: 'Queued message', status: 'queued', position: 1, pausedReason: null }],
          },
        })}
        permissionMode="auto"
        onDraftChange={() => undefined}
        onSubmit={() => undefined}
        onInterrupt={() => undefined}
      />,
    );

    expect(idle).toContain('data-primary-command-slot="true"');
    expect(idle).toContain('aria-label="Send"');
    expect(active).toContain('data-primary-command-slot="true"');
    expect(active).toContain('aria-label="Stop"');
    expect(active).toContain('Queue');
    expect(active).toContain('Steer');
    expect(active).toContain('Edit queued message');
    expect(active).toContain('Delete queued message');
    expect(active).toContain('Send queued message now');
    expect(active).toContain('session-queue-drag-handle');
    expect(active).not.toContain('Retry all');
  });

  it('disables steer for a stale active turn and shows unsynced model and effort facts', () => {
    const html = renderToStaticMarkup(
      <ConversationComposer
        language="en-US"
        state={sessionState({ conversationState: 'active_prework', activeTurnId: 'turn-2', startedTurnId: 'turn-1', draft: 'Do not steer stale turn', providerSettings: null })}
        permissionMode="auto"
        onDraftChange={() => undefined}
        onSubmit={() => undefined}
        onInterrupt={() => undefined}
      />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Steer<\/button>|<button[^>]*>Steer<\/button>/);
    expect(html).toContain('Model: Not synced');
    expect(html).toContain('Reasoning effort: Not synced');
  });

  it('disables Queue and Steer when the transport is not writable', () => {
    const html = renderToStaticMarkup(
      <ConversationComposer
        language="en-US"
        state={sessionState({ transportState: 'reconnecting', conversationState: 'active_prework', activeTurnId: 'turn-1', startedTurnId: 'turn-1', draft: 'Do not dispatch yet' })}
        permissionMode="auto"
        onDraftChange={() => undefined}
        onSubmit={() => undefined}
        onInterrupt={() => undefined}
      />,
    );

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-pressed="true"[^>]*>Queue<\/button>|<button[^>]*aria-pressed="true"[^>]*disabled=""[^>]*>Queue<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-pressed="false"[^>]*>Steer<\/button>|<button[^>]*aria-pressed="false"[^>]*disabled=""[^>]*>Steer<\/button>/);
    expect(html).toMatch(/class="session-active-draft-submit"[^>]*disabled=""/);
  });

  it('shows a compact native permission selector and requires explicit confirmation before full access', () => {
    const html = renderToStaticMarkup(<PermissionModeControl language="en-US" value="auto" onChange={() => undefined} />);

    expect(html).toContain('class="session-permission-control"');
    expect(html).toContain('aria-label="Permission mode"');
    expect(html).toContain('<option value="read-only">Read only</option>');
    expect(html).toContain('<option value="auto" selected="">Auto</option>');
    expect(html).toContain('<option value="full-access">Full access</option>');
    expect(requiresPermissionModeConfirmation('auto', 'full-access')).toBe(true);
    expect(requiresPermissionModeConfirmation('full-access', 'full-access')).toBe(false);
    expect(requiresPermissionModeConfirmation('auto', 'read-only')).toBe(false);
  });

  it('locks permission changes whenever the conversation is not idle', () => {
    const waiting = renderToStaticMarkup(
      <ConversationComposer
        language="en-US"
        state={sessionState({ conversationState: 'waiting_approval' })}
        permissionMode="auto"
        onPermissionModeChange={() => undefined}
        onDraftChange={() => undefined}
        onSubmit={() => undefined}
        onInterrupt={() => undefined}
      />,
    );

    expect(waiting).toMatch(/<select[^>]*aria-label="Permission mode"[^>]*title="Permission mode can change only while the conversation is idle"[^>]*disabled=""/);
  });

  it('uses fieldset semantics for approvals and request_user_input, including masked secret input', () => {
    const approval = renderToStaticMarkup(
      <PendingRequestSurface
        language="en-US"
        request={request({ payload: { command: ['/bin/pwd'], reason: 'Read the selected project directory.', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] } })}
        onRespond={() => undefined}
      />,
    );
    const rui = renderToStaticMarkup(
      <PendingRequestSurface
        language="en-US"
        request={request({
          id: 'request-rui',
          type: 'request_user_input',
          containsSecret: true,
          payload: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'request-rui-item',
            questions: [
              {
                id: 'scope',
                header: 'Scope',
                question: 'Choose scope',
                options: [
                  { label: 'Workspace', description: 'Only this workspace.' },
                  { label: 'Cancel', description: 'Do not continue.' },
                ],
                isOther: false,
                isSecret: false,
              },
              { id: 'token', header: 'Token', question: 'Temporary token', options: null, isOther: false, isSecret: true },
            ],
            autoResolutionMs: null,
          },
        })}
        onRespond={() => undefined}
      />,
    );

    expect(approval).toContain('<fieldset');
    expect(approval).toContain('<legend>Approval required</legend>');
    expect(approval).toContain('Read the selected project directory.');
    expect(approval).toContain('Allow for session');
    expect(approval).toContain('Cancel');
    expect(rui).toContain('<fieldset');
    expect(rui).toContain('type="radio"');
    expect(rui).toContain('type="password"');
    expect(rui).not.toContain('Temporary token</output>');
  });

  it('renders unknown approvals fail-closed and never enables malformed MCP acceptance', () => {
    const unknown = renderToStaticMarkup(<PendingRequestSurface language="en-US" request={request({ type: 'surprise', payload: { availableDecisions: ['accept'] } })} onRespond={() => undefined} />);
    const invalidMcp = renderToStaticMarkup(
      <PendingRequestSurface language="en-US" request={request({ type: 'mcp', payload: { content: { bad: Number.NaN }, _meta: {}, availableDecisions: ['accept', 'decline'] } })} onRespond={() => undefined} />,
    );
    expect(unknown).toContain('Unsupported request type');
    expect(unknown).not.toContain('Allow once');
    expect(invalidMcp).toContain('Invalid MCP response payload');
    expect(invalidMcp).not.toContain('Allow once');
  });

  it('keeps parity styles scoped, supports dark/system themes, and fixes the composer width at 650px', () => {
    const css = readFileSync(new URL('../src/renderer/session/session.css', import.meta.url), 'utf8');
    const source = readFileSync(new URL('../src/renderer/session/SessionWorkspace.tsx', import.meta.url), 'utf8');

    expect(css).toContain('--session-composer-max: 650px');
    expect(css).toMatch(/\.session-codex-parity-v1 \.session-composer-shell\s*\{[^}]*inline-size:\s*min\(var\(--session-composer-max\)/s);
    expect(css).toContain('.theme-dark .session-codex-parity-v1');
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)[\s\S]*\.theme-system \.session-codex-parity-v1/);
    expect(css).not.toContain(':where(p, span, small, em, label) {\n  color: inherit;');
    expect(css).not.toContain('text-indent: 40px');
    expect(source).toContain("setTitleMotion('exiting')");
    expect(source).toContain('data-motion-title={titleMotion}');
  });

  it('uses one neutral composer focus boundary instead of stacked blue focus rings', () => {
    const css = readFileSync(new URL('../src/renderer/session/session.css', import.meta.url), 'utf8');
    const focusRule = css.match(/\.session-codex-parity-v1 \.session-composer-input-frame:focus-within\s*\{([^}]*)\}/)?.[1] ?? '';
    const textareaRule = css.match(/^\.session-codex-parity-v1 \.session-composer-input-frame > textarea\s*\{([^}]*)\}/m)?.[1] ?? '';

    expect(css).toContain('--session-composer-focus-line:');
    expect(focusRule).toContain('border-color: var(--session-composer-focus-line)');
    expect(focusRule).not.toContain('0 0 0 3px var(--session-focus)');
    expect(textareaRule).toContain('box-shadow: none');
    expect(css).toMatch(/\.session-codex-parity-v1 button:focus-visible,[\s\S]*outline:\s*2px solid var\(--session-focus-outline\)/);
  });
});
