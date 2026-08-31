import { ConversationTranscript } from '../src/renderer/session/ConversationTranscript.js';
import { createInitialSessionState } from '../src/renderer/session/sessionReducer.js';
import type { NativeQueuedSubmission, NativeSessionItemBuffer, NativeSessionState } from '../src/renderer/session/sessionTypes.js';

const steeringConversationId = 'steering-conversation';
const steeringThreadId = 'steering-thread';
const steeringTurnId = 'steering-turn';
const steeringSubmission: NativeQueuedSubmission = {
  id: 'queued-steering-message',
  conversationId: steeringConversationId,
  content: '点击引导后立即进入思考过程。',
  status: 'queued',
  delivery: 'queue',
  position: 0,
  providerTurnId: null,
  clientUserMessageId: 'queued-steering-client',
  pausedReason: null,
  createdAt: '2026-08-15T04:02:00.000Z',
  updatedAt: '2026-08-15T04:02:00.000Z',
};

function steeringItem(id: string, type: string, status: string, text: string, timelineAt: string, payload: Record<string, unknown> = {}): NativeSessionItemBuffer {
  const user = type === 'userMessage';
  return {
    key: `steering:${id}`,
    conversationId: steeringConversationId,
    threadId: steeringThreadId,
    turnId: steeringTurnId,
    itemId: `steering-${id}`,
    type,
    status,
    phase: typeof payload.phase === 'string' ? payload.phase : 'prework',
    text,
    payload,
    resources: [],
    timelineAt,
    updatedAt: timelineAt,
    ...(user
      ? {
          clientUserMessageId: `steering-${id}-client`,
          durableClientUserMessageId: `steering-${id}-client`,
        }
      : {}),
  };
}

const steeringOpening = steeringItem('opening', 'userMessage', 'completed', '先检查当前页面为什么没有显示消息。', '2026-08-15T04:01:00.000Z', { role: 'user' });
const steeringBeforeSummary = steeringItem('before-summary', 'agentMessage', 'completed', '我先核对消息投影和渲染顺序。', '2026-08-15T04:01:10.000Z', {
  role: 'assistant',
  phase: 'prework',
});
const steeringBeforeCommand = steeringItem('before-command', 'commandExecution', 'completed', '', '2026-08-15T04:01:20.000Z', {
  command: ['rg', 'ConversationTranscript'],
  commandActions: [{ type: 'read', path: 'apps/desktop/src/renderer/session/ConversationTranscript.tsx' }],
});
const steeringSucceeded = steeringItem('succeeded-guide', 'userMessage', 'completed', '鼠标滚动一下后，就显示出来了', '2026-08-15T04:01:30.000Z', {
  role: 'user',
  delivery: 'steer_now',
});
const steeringAfterSummary = steeringItem('after-summary', 'agentMessage', 'completed', '这条引导之后继续排查首次绘制与测量。', '2026-08-15T04:01:40.000Z', {
  role: 'assistant',
  phase: 'prework',
});
const steeringReasoning = steeringItem('reasoning', 'reasoning', 'in_progress', '当前回复仍在执行，等待新的引导内容接管。', '2026-08-15T04:01:50.000Z', {
  summary: ['当前回复仍在执行，等待新的引导内容接管。'],
});

const steeringInitialState: NativeSessionState = {
  ...createInitialSessionState(),
  transportState: 'ready',
  conversationState: 'active_prework',
  projectId: 'project-zeus',
  conversationId: steeringConversationId,
  providerThreadId: steeringThreadId,
  activeTurnId: steeringTurnId,
  startedTurnId: steeringTurnId,
  snapshot: { id: steeringConversationId } as NonNullable<NativeSessionState['snapshot']>,
  items: Object.fromEntries([steeringOpening, steeringBeforeSummary, steeringBeforeCommand, steeringSucceeded, steeringAfterSummary, steeringReasoning].map((item) => [item.key, item])),
  itemOrder: [steeringOpening.key, steeringBeforeSummary.key, steeringBeforeCommand.key, steeringSucceeded.key, steeringAfterSummary.key, steeringReasoning.key],
  turnsByProviderId: {
    [steeringTurnId]: {
      id: steeringTurnId,
      providerTurnId: steeringTurnId,
      submissionId: 'steering-opening-submission',
      status: 'running',
      error: null,
      plan: null,
      startedAt: steeringOpening.timelineAt,
      completedAt: null,
      createdAt: steeringOpening.timelineAt ?? '2026-08-15T04:01:00.000Z',
      updatedAt: steeringReasoning.updatedAt ?? '2026-08-15T04:01:50.000Z',
    },
  },
  queue: {
    state: { type: 'active', turnId: steeringTurnId, phase: 'prework' },
    waitReason: 'current_turn',
    submissions: [steeringSubmission],
  },
  transcriptRevision: 1,
};

export function SteeringPreview() {
  const steeringState = steeringInitialState.queue?.submissions.find((entry) => entry.id === steeringSubmission.id)?.status;
  return (
    <section className="qa-motion-send-preview session-codex-parity-v1" data-testid="steering-preview">
      <div>
        <h3>排队消息引导立即接管</h3>
        <small data-testid="steering-status">{steeringState === 'steering' ? '引导中，消息保留在队列，等待当前轮次确认' : steeringInitialState.queue?.submissions.length ? '排队中' : '已按正常引导进入当前思考过程'}</small>
      </div>
      <div className="qa-send-transcript ai-workspace">
        <ConversationTranscript state={steeringInitialState} language="zh-CN" />
      </div>
    </section>
  );
}

export function SteeringQaApp() {
  return (
    <main className="macos-ai-app zeus-shell qa-page qa-motion-page">
      <SteeringPreview />
    </main>
  );
}
