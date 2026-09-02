import React from 'react';
import type { NativeConversationChoice, NativeConversationSnapshot, NativeSessionState } from '../src/renderer/session/sessionTypes.js';
import { createInitialSessionState } from '../src/renderer/session/sessionReducer.js';
import { SessionWorkspace } from '../src/renderer/session/SessionWorkspace.js';
import { conversation } from './session-qa-fixtures.js';

const conversationId = 'zeus-0296-plan-preview';
const turnId = 'zeus-0296-plan-turn';
const updatedAt = '2026-09-02T01:30:00.000Z';

const state: NativeSessionState = {
  ...createInitialSessionState(),
  transportState: 'ready',
  conversationState: 'native_idle',
  projectId: 'project-zeus',
  conversationId,
  providerThreadId: `thread-${conversationId}`,
  snapshot: { id: conversationId } as NativeConversationSnapshot,
  turnsByProviderId: {
    [turnId]: {
      id: turnId,
      providerTurnId: turnId,
      submissionId: null,
      status: 'completed',
      plan: {
        explanation: '# ZEUS-0296 开发计划\n\nZEUS-0296 计划预览首段',
        steps: [
          { step: '点击计划后，右侧显示当前计划的完整正文。', status: 'completed' },
          { step: 'ZEUS-0296 计划预览末段', status: 'completed' },
        ],
      },
      startedAt: '2026-09-02T01:29:00.000Z',
      completedAt: updatedAt,
      createdAt: '2026-09-02T01:29:00.000Z',
      updatedAt,
    },
  },
  terminalTurnIds: { [turnId]: 'completed' },
  planImplementationRequests: [
    {
      id: 'zeus-0296-plan-request',
      conversationId,
      turnId,
      planItemId: 'zeus-0296-plan-item',
      status: 'implemented',
      submissionId: null,
      createdAt: updatedAt,
      resolvedAt: updatedAt,
      updatedAt,
    },
  ],
  transcriptRevision: 1,
};

function PlanPreviewQaApp(props: { historyOnly: boolean }) {
  const baseConversation = conversation(conversationId, 'task-zeus-0296', updatedAt);
  const selectedConversation: NativeConversationChoice = props.historyOnly
    ? { ...baseConversation, title: 'ZEUS-0296 历史计划预览', status: 'archived', providerState: 'archived', archived: true, readOnly: true }
    : { ...baseConversation, title: 'ZEUS-0296 活动计划预览' };

  return (
    <main className="macos-ai-app zeus-shell qa-page qa-motion-page qa-plan-preview-page" data-testid={props.historyOnly ? 'plan-preview-history' : 'plan-preview-active'}>
      <header className="qa-heading">
        <p>ZEUS-0296 · Snapshot V2 计划预览</p>
        <h1>{props.historyOnly ? '历史/归档会话' : '活动会话'}</h1>
      </header>
      <section className="qa-implementation-panel qa-plan-preview-workspace session-codex-parity-v1 theme-light">
        <SessionWorkspace language="zh-CN" state={state} conversation={selectedConversation} task={null} suppressComposer quickActionsSuppressed historyOnly={props.historyOnly} projectPersistedPlans transcriptLoading={false} />
      </section>
    </main>
  );
}

export function PlanPreviewActiveQaApp() {
  return <PlanPreviewQaApp historyOnly={false} />;
}

export function PlanPreviewHistoryQaApp() {
  return <PlanPreviewQaApp historyOnly />;
}
