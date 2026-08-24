import React, { useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { GlobeSimpleIcon as GlobeSimple } from '@phosphor-icons/react/dist/csr/GlobeSimple';
import '../src/renderer/styles.css';
import '../src/renderer/session/session.css';
import './session-styles.css';
import type { ConversationResource, ConversationResourcePreview } from '@zeus/shared';
import { PendingRequestSurface } from '../src/renderer/session/PendingRequestSurface.js';
import { type ConversationTreeRuntimeState, type ProjectConversationGroup, ProjectConversationTree } from '../src/renderer/session/ProjectConversationTree.js';
import type { NativeConversationAttachment, NativeConversationChoice, NativePendingRequest, NativeQueuedSubmission, NativeRuntimeDetailsSnapshot, NativeSessionItemBuffer, NativeSessionState } from '../src/renderer/session/sessionTypes.js';
import { SafeMarkdown, ThreadItemView } from '../src/renderer/session/ThreadItemView.js';
import { ConversationTranscript } from '../src/renderer/session/ConversationTranscript.js';
import { ConversationComposer } from '../src/renderer/session/ConversationComposer.js';
import { PlanSummary } from '../src/renderer/session/PlanSummary.js';
import { RuntimeDetails } from '../src/renderer/session/RuntimeDetails.js';
import { SessionPlanProgress } from '../src/renderer/session/SessionActivity.js';
import { createInitialSessionState, sessionReducer } from '../src/renderer/session/sessionReducer.js';
import { resolveNativeConversationSelectionPresentation } from '../src/renderer/features/workspace/workspaceSupport.js';
import { ApplicationErrorDialogHost, reportApplicationError, VisibleApplicationError } from '../src/renderer/ui/ApplicationErrorDialog.js';

declare global {
  interface Window {
    __zeusSessionStylesRoot?: Root;
  }
}

const referenceBase = 'http://127.0.0.1:4181';

function conversation(id: string, taskId: string, updatedAt: string, hasUnreadAttention = false): NativeConversationChoice {
  return {
    id,
    projectId: 'project-zeus',
    taskId,
    title: id,
    summary: null,
    status: 'active',
    stage: 'ready',
    stageUpdatedAt: updatedAt,
    transportKind: 'codex_native',
    providerId: 'codex',
    providerThreadId: `thread-${id}`,
    providerModel: 'gpt-5.6-sol',
    providerState: 'ready',
    createdAt: updatedAt,
    updatedAt,
    archived: false,
    hasUnreadAttention,
    attentionKind: hasUnreadAttention ? 'unread' : 'none',
    attentionRevision: hasUnreadAttention ? 1 : 0,
    attentionTurnId: null,
    attentionUpdatedAt: hasUnreadAttention ? updatedAt : null,
    pendingRequestKind: null,
    resumable: true,
    readOnly: false,
  };
}

const approvalConversation = conversation('approval', 'task-approval', '2026-07-22T08:04:00.000Z');
const inputConversation = conversation('input', 'task-input', '2026-07-22T08:03:00.000Z');
const unreadConversation = conversation('unread', 'task-unread', '2026-07-22T08:02:00.000Z', true);
const runningConversation = conversation('running', 'task-running', '2026-07-22T08:01:00.000Z');

const groups: ProjectConversationGroup[] = [
  {
    projectId: 'project-zeus',
    projectName: 'zeus',
    taskStatuses: [{ id: 'in_development', label: '开发中' }],
    tasks: [
      {
        taskId: 'task-approval',
        taskCode: 'TASK-20260722-001',
        taskTitle: '检查未提交变更',
        managementStatus: 'in_development',
        conversations: [approvalConversation],
      },
      {
        taskId: 'task-input',
        taskCode: 'TASK-20260722-002',
        taskTitle: '修复已有维护单回调',
        managementStatus: 'in_development',
        conversations: [inputConversation],
      },
      {
        taskId: 'task-unread',
        taskCode: 'TASK-20260722-003',
        taskTitle: '优化归档会话恢复继续',
        managementStatus: 'in_development',
        conversations: [unreadConversation],
      },
      {
        taskId: 'task-running',
        taskCode: 'TASK-20260722-004',
        taskTitle: '优化 Codex 会话列表样式',
        managementStatus: 'in_development',
        conversations: [runningConversation],
      },
    ],
  },
];

const conversationStates: Record<string, ConversationTreeRuntimeState> = {
  approval: 'pending_approval',
  input: 'pending_user_input',
  unread: 'ready',
  running: 'streaming',
};

const inlineResourceItems: ConversationResource[] = [
  {
    id: 'resource-thread-item-view',
    projectId: 'project-zeus',
    conversationId: 'conversation-resource-style',
    turnId: 'turn-resource-style',
    itemId: 'item-resource-style',
    kind: 'file',
    presentation: 'inline',
    displayName: 'ThreadItemView.tsx',
    projectRelativePath: 'apps/desktop/src/renderer/session/ThreadItemView.tsx',
    location: { line: 647 },
    iconKind: 'typescript',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  },
  {
    id: 'resource-openai-docs',
    projectId: 'project-zeus',
    conversationId: 'conversation-resource-style',
    turnId: 'turn-resource-style',
    itemId: 'item-resource-style',
    kind: 'website',
    presentation: 'inline',
    displayName: 'OpenAI 开发者文档',
    url: 'https://developers.openai.com/',
    domain: 'developers.openai.com',
    title: 'OpenAI 开发者文档',
    local: false,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  },
];

const inlineResourceMarkdown = '已完成 [ThreadItemView.tsx](apps/desktop/src/renderer/session/ThreadItemView.tsx:647) 与 [OpenAI 开发者文档](https://developers.openai.com/)；未取得受信资源的 [项目外文件](/tmp/outside.txt) 保持正文色。';

function ignoreResourceOpen() {}

const motionConversationId = 'motion-conversation';
const motionThreadId = 'motion-thread';
const motionTurnId = 'motion-turn';

function motionItem(id: string, type: string, status: string, text: string, payload: Record<string, unknown> = {}, phase = 'prework'): NativeSessionItemBuffer {
  return {
    key: `motion:${id}`,
    conversationId: motionConversationId,
    threadId: motionThreadId,
    turnId: motionTurnId,
    itemId: id,
    type,
    status,
    phase,
    text,
    payload,
    resources: [],
    updatedAt: '2026-08-15T04:00:00.000Z',
  };
}

const motionReasoning = motionItem('reasoning', 'reasoning', 'in_progress', '先确认当前交互阶段，再把活动焦点交给最新输出。', { summary: ['先确认当前交互阶段，再把活动焦点交给最新输出。'] });
const motionActivity = motionItem('activity', 'commandExecution', 'in_progress', '', {
  command: ['pnpm', 'typecheck'],
  commandActions: [{ type: 'read', path: 'apps/desktop/src/renderer/session/ConversationTranscript.tsx' }],
});
const motionAnswer = motionItem('answer', 'agentMessage', 'in_progress', '会话进行中的视觉焦点已经接管到回答正文：\n\n- 思考和工具阶段保持静态\n- 光标紧跟最后一项内容', { phase: 'final_answer' }, 'final_answer');

const motionSessionState: NativeSessionState = {
  ...createInitialSessionState(),
  transportState: 'ready',
  conversationState: 'active_final_answer',
  projectId: 'project-zeus',
  conversationId: motionConversationId,
  providerThreadId: motionThreadId,
  activeTurnId: motionTurnId,
  startedTurnId: motionTurnId,
  items: {
    [motionReasoning.key]: motionReasoning,
    [motionActivity.key]: motionActivity,
    [motionAnswer.key]: motionAnswer,
  },
  itemOrder: [motionReasoning.key, motionActivity.key, motionAnswer.key],
  turnsByProviderId: {
    [motionTurnId]: {
      id: motionTurnId,
      providerTurnId: motionTurnId,
      submissionId: null,
      status: 'running',
      startedAt: '2026-08-15T04:00:00.000Z',
      completedAt: null,
      createdAt: '2026-08-15T04:00:00.000Z',
      updatedAt: '2026-08-15T04:00:14.000Z',
    },
  },
  transcriptRevision: 1,
};

const flowCompletedCommand = motionItem('flow-completed-command', 'commandExecution', 'completed', '', {
  command: ['/bin/zsh', '-lc', 'pnpm install --frozen-lockfile --offline'],
});
const flowReasoningMiddle = motionItem('flow-reasoning-middle', 'reasoning', 'in_progress', 'Formatting and typechecking code', {
  summary: ['Formatting and typechecking code'],
});
const flowRunningCommand = motionItem('flow-running-command', 'commandExecution', 'in_progress', '', {
  command: ['/bin/zsh', '-lc', 'pnpm exec prettier --write apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/session/ConversationTranscript.tsx'],
});
const flowReasoningLatest = motionItem('flow-reasoning-latest', 'reasoning', 'in_progress', 'Checking the formatted output', {
  summary: ['Checking the formatted output'],
});

function activityFlowState(latest: boolean): NativeSessionState {
  const items = latest ? [flowCompletedCommand, flowReasoningMiddle, flowRunningCommand, flowReasoningLatest] : [flowCompletedCommand, flowReasoningMiddle, flowRunningCommand];
  return {
    ...createInitialSessionState(),
    transportState: 'ready',
    conversationState: 'active_prework',
    projectId: 'project-zeus',
    conversationId: motionConversationId,
    providerThreadId: motionThreadId,
    activeTurnId: motionTurnId,
    startedTurnId: motionTurnId,
    items: Object.fromEntries(items.map((item) => [item.key, item])),
    itemOrder: items.map((item) => item.key),
    turnsByProviderId: motionSessionState.turnsByProviderId,
    transcriptRevision: latest ? 3 : 2,
  };
}

const executionPhasePreviousReasoning = motionItem('phase-reasoning-previous', 'reasoning', 'completed', '先检查上一阶段的工作结果。', {
  summary: ['先检查上一阶段的工作结果。'],
});
const executionPhaseReasoning = motionItem('phase-reasoning-current', 'reasoning', 'in_progress', '现在按类别聚合工具、命令和文件活动，完成后再继续输出。', {
  summary: ['现在按类别聚合工具、命令和文件活动，完成后再继续输出。'],
});
const executionPhaseActivities = Array.from({ length: 40 }, (_, index) => {
  const sequence = index + 1;
  const status = index === 39 ? 'in_progress' : 'completed';
  if (index % 4 === 0) {
    return motionItem(`phase-command-${sequence}`, 'commandExecution', status, '', {
      command: ['pnpm', index % 8 === 0 ? 'typecheck' : 'lint'],
      commandActions: [{ type: 'run', path: 'apps/desktop' }],
    });
  }
  if (index % 4 === 1) {
    return motionItem(`phase-search-${sequence}`, 'webSearch', status, '', {
      query: `Zeus 会话分组验收 ${sequence}`,
    });
  }
  if (index % 4 === 2) {
    return motionItem(`phase-file-${sequence}`, 'fileChange', status, '', {
      path: `apps/desktop/src/renderer/session/fixture-${sequence}.tsx`,
    });
  }
  return motionItem(`phase-tool-${sequence}`, 'dynamicToolCall', status, '', {
    toolName: index % 8 === 3 ? 'browser' : 'openai_docs',
  });
});
const executionPhaseCommentary = motionItem('phase-commentary', 'agentMessage', 'completed', '活动组已经建立；继续追加操作时不改变它在本轮中的位置。', { phase: 'commentary' }, 'commentary');
const executionPhaseLaterReasoning = motionItem('phase-reasoning-later', 'reasoning', 'in_progress', '继续核对 32 条阈值后的稳定分组。', {
  summary: ['继续核对 32 条阈值后的稳定分组。'],
});
const executionPhaseAppendedActivity = motionItem('phase-appended-tool', 'dynamicToolCall', 'in_progress', '', { toolName: 'browser' });
const executionPhaseFinalAnswer = motionItem('phase-final-answer', 'agentMessage', 'completed', '本轮过程已完成，所有操作仍归于同一个活动组。', { phase: 'final_answer' }, 'final_answer');

function executionPhaseState(options: { appended: boolean; completed: boolean }): NativeSessionState {
  const baseActivities = options.completed ? executionPhaseActivities.map((item) => ({ ...item, status: 'completed' })) : executionPhaseActivities;
  const items = [
    executionPhasePreviousReasoning,
    ...baseActivities.slice(0, 12),
    executionPhaseCommentary,
    executionPhaseReasoning,
    ...baseActivities.slice(12, 33),
    executionPhaseLaterReasoning,
    ...baseActivities.slice(33),
    ...(options.appended ? [{ ...executionPhaseAppendedActivity, status: options.completed ? 'completed' : 'in_progress' }] : []),
    ...(options.completed ? [executionPhaseFinalAnswer] : []),
  ].map((item, index) => {
    const timelineAt = new Date(Date.UTC(2026, 7, 15, 4, 0, index)).toISOString();
    return { ...item, timelineAt, updatedAt: timelineAt };
  });
  return {
    ...createInitialSessionState(),
    transportState: 'ready',
    conversationState: options.completed ? 'ready' : 'active_prework',
    projectId: 'project-zeus',
    conversationId: motionConversationId,
    providerThreadId: motionThreadId,
    activeTurnId: options.completed ? null : motionTurnId,
    startedTurnId: motionTurnId,
    // 视觉夹具只需要证明已水合后的滚动与新增消息路径，快照其余字段不参与渲染。
    snapshot: { id: motionConversationId } as NonNullable<NativeSessionState['snapshot']>,
    items: Object.fromEntries(items.map((item) => [item.key, item])),
    itemOrder: items.map((item) => item.key),
    turnsByProviderId: {
      [motionTurnId]: {
        ...motionSessionState.turnsByProviderId[motionTurnId]!,
        status: options.completed ? 'completed' : 'running',
        completedAt: options.completed ? '2026-08-15T04:01:00.000Z' : null,
      },
    },
    terminalTurnIds: options.completed ? { [motionTurnId]: 'completed' } : {},
    transcriptRevision: 40 + Number(options.appended) + Number(options.completed),
  };
}

const longScrollConversationId = 'long-scroll-conversation';

function longScrollItem(index: number, expanded: boolean): NativeSessionItemBuffer {
  const lineCount = index % 5 === 0 ? 7 : index % 3 === 0 ? 4 : 1;
  const extra = expanded && index === 24 ? 12 : 0;
  const lines = Array.from({ length: lineCount + extra }, (_, line) => `混合高度消息 ${index + 1} · 第 ${line + 1} 行，验证延迟高度变化不会让可见锚点跳动。`);
  return {
    ...motionItem(`long-scroll-${index}`, 'agentMessage', 'completed', lines.join('\n\n'), { phase: 'final_answer' }, 'final_answer'),
    conversationId: longScrollConversationId,
    threadId: 'long-scroll-thread',
    turnId: `long-scroll-turn-${index}`,
    key: `long-scroll:row-${index}`,
    updatedAt: new Date(Date.UTC(2026, 7, 15, 4, index)).toISOString(),
  };
}

function longScrollState(expanded: boolean): NativeSessionState {
  const items = Array.from({ length: 72 }, (_, index) => longScrollItem(index, expanded));
  return {
    ...createInitialSessionState(),
    transportState: 'ready',
    conversationState: 'ready',
    projectId: 'project-zeus',
    conversationId: longScrollConversationId,
    providerThreadId: 'long-scroll-thread',
    snapshot: { id: longScrollConversationId } as NonNullable<NativeSessionState['snapshot']>,
    items: Object.fromEntries(items.map((item) => [item.key, item])),
    itemOrder: items.map((item) => item.key),
    transcriptRevision: expanded ? 2 : 1,
  };
}

const failedComposerAttachment: NativeConversationAttachment = {
  name: 'failed-message.txt',
  mime: 'text/plain',
  size: 18,
  kind: 'file',
  source: 'picker',
  uploadRef: 'qa-failed-message',
};
const laterComposerAttachment: NativeConversationAttachment = {
  name: 'later-draft.txt',
  mime: 'text/plain',
  size: 12,
  kind: 'file',
  source: 'picker',
  uploadRef: 'qa-later-draft',
};
const noRefillError = {
  code: 'ZEUS_CODEX_RPC_TIMEOUT',
  message: 'Codex app-server request timed out: account/read',
  recoveryRequired: true,
  retryable: false,
};

function lateFailureNoRefillState(): NativeSessionState {
  const initial = { ...createInitialSessionState(), conversationId: 'no-refill-late', providerThreadId: 'no-refill-thread', transportState: 'ready' as const, conversationState: 'ready' as const };
  const started = sessionReducer(initial, {
    type: 'send_started',
    clientUserMessageId: 'failed-client-message',
    durableClientUserMessageId: 'failed-client-message',
    draft: '已经发送但失败的旧消息',
    attachments: [failedComposerAttachment],
    submittedAttachments: [failedComposerAttachment],
    browserSubmission: null,
    contextDraft: initial.contextDraft,
    browserComments: [],
    delivery: 'queue',
    previousConversationState: 'ready',
    startedAt: '2026-08-24T06:00:00.000Z',
  });
  const withLaterDraft = sessionReducer(sessionReducer(started, { type: 'draft_changed', draft: '用户后来输入的新草稿' }), {
    type: 'attachments_changed',
    attachments: [laterComposerAttachment],
  });
  return sessionReducer(withLaterDraft, {
    type: 'send_failed',
    clientUserMessageId: 'failed-client-message',
    previousConversationState: 'ready',
    error: noRefillError,
  });
}

function restartFailureNoRefillState(): NativeSessionState {
  const initial = { ...createInitialSessionState(), conversationId: 'no-refill-restart', providerThreadId: 'no-refill-thread', transportState: 'ready' as const, conversationState: 'ready' as const };
  const projected = sessionReducer(initial, {
    type: 'send_started',
    clientUserMessageId: 'restart-failed-client-message',
    durableClientUserMessageId: 'restart-failed-client-message',
    draft: '重启前失败的消息',
    attachments: [failedComposerAttachment],
    submittedAttachments: [failedComposerAttachment],
    browserSubmission: null,
    contextDraft: initial.contextDraft,
    browserComments: [],
    delivery: 'queue',
    previousConversationState: 'ready',
    startedAt: '2026-08-24T06:00:00.000Z',
    preserveComposer: true,
  });
  return sessionReducer(projected, {
    type: 'send_uncertain',
    clientUserMessageId: 'restart-failed-client-message',
    previousConversationState: 'ready',
    error: noRefillError,
  });
}

const sendScrollConversationId = 'send-scroll-conversation';
const sendScrollTurnId = 'send-scroll-turn';
const sendScrollSnapshot = { id: sendScrollConversationId } as NonNullable<NativeSessionState['snapshot']>;
const sendScrollItems = Array.from({ length: 8 }, (_, index) => motionItem(`send-history-${index}`, 'agentMessage', 'completed', `历史回答 ${index + 1}：用于制造可滚动的会话内容。`, { phase: 'final_answer' })).map((item) => ({
  ...item,
  conversationId: sendScrollConversationId,
  threadId: 'send-scroll-thread',
  turnId: sendScrollTurnId,
}));
const sendScrollInitialState: NativeSessionState = {
  ...createInitialSessionState(),
  transportState: 'ready',
  conversationState: 'ready',
  projectId: 'project-zeus',
  conversationId: sendScrollConversationId,
  providerThreadId: 'send-scroll-thread',
  snapshot: sendScrollSnapshot,
  items: Object.fromEntries(sendScrollItems.map((item) => [item.key, item])),
  itemOrder: sendScrollItems.map((item) => item.key),
  turnsByProviderId: {
    [sendScrollTurnId]: {
      id: sendScrollTurnId,
      providerTurnId: sendScrollTurnId,
      submissionId: null,
      status: 'completed',
      startedAt: '2026-08-15T04:00:00.000Z',
      completedAt: '2026-08-15T04:01:00.000Z',
      createdAt: '2026-08-15T04:00:00.000Z',
      updatedAt: '2026-08-15T04:01:00.000Z',
    },
  },
  transcriptRevision: 1,
};

const historyPagingConversationId = 'history-paging-conversation';
const historyPagingItems = sendScrollItems.map((item) => ({ ...item, conversationId: historyPagingConversationId }));
const historyPagingSessionState: NativeSessionState = {
  ...sendScrollInitialState,
  conversationId: historyPagingConversationId,
  snapshot: {
    id: historyPagingConversationId,
    snapshotV2: { activeTurn: null, recentClosedTurns: [] },
    v2Paging: {
      history: { nextCursor: 'history-page-2', hasMore: true, loading: true, error: null },
      historyByTurn: {},
      processByTurn: {},
      resources: { nextCursor: null, hasMore: false, loading: false, loaded: true, error: null, items: [] },
      changeSetsByTurn: {},
    },
  } as NonNullable<NativeSessionState['snapshot']>,
  items: Object.fromEntries(historyPagingItems.map((item) => [item.key, item])),
  itemOrder: historyPagingItems.map((item) => item.key),
};

const deliveryFailureConversationId = 'delivery-failure-conversation';
const deliveryFailureItem: NativeSessionItemBuffer = {
  ...motionItem('delivery-failure', 'userMessage', 'unconfirmed', '是，实施此计划', {
    role: 'user',
    delivery: 'queue',
    pausedReason: 'recovery_required',
    deliveryError: {
      code: 'ZEUS_CODEX_RPC_TIMEOUT',
      message: 'Codex app-server request timed out: thread/read',
      recoveryRequired: true,
      retryable: false,
    },
  }),
  conversationId: deliveryFailureConversationId,
  threadId: 'delivery-failure-thread',
  turnId: 'pending:delivery-failure',
  optimistic: true,
};
const deliveryFailureSessionState: NativeSessionState = {
  ...createInitialSessionState(),
  transportState: 'ready',
  conversationState: 'ready',
  projectId: 'project-zeus',
  conversationId: deliveryFailureConversationId,
  providerThreadId: 'delivery-failure-thread',
  snapshot: { id: deliveryFailureConversationId } as NonNullable<NativeSessionState['snapshot']>,
  items: { [deliveryFailureItem.key]: deliveryFailureItem },
  itemOrder: [deliveryFailureItem.key],
  transcriptRevision: 1,
};

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
const steeringReasoning: NativeSessionItemBuffer = {
  ...motionReasoning,
  key: 'steering:reasoning',
  conversationId: steeringConversationId,
  threadId: steeringThreadId,
  turnId: steeringTurnId,
  itemId: 'steering-reasoning',
  text: '当前回复仍在执行，等待新的引导内容接管。',
  payload: { summary: ['当前回复仍在执行，等待新的引导内容接管。'] },
};
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
  items: { [steeringReasoning.key]: steeringReasoning },
  itemOrder: [steeringReasoning.key],
  queue: {
    state: { type: 'active', turnId: steeringTurnId, phase: 'prework' },
    waitReason: 'current_turn',
    submissions: [steeringSubmission],
  },
  transcriptRevision: 1,
};

const runtimeDetailsFixture: NativeRuntimeDetailsSnapshot = {
  model: { state: 'available', value: 'gpt-5.6-sol' },
  effort: { state: 'available', value: 'xhigh' },
  serviceTier: { state: 'available', value: null },
  usage: {
    totalTokens: { state: 'available', value: 52_115_419 },
    inputTokens: { state: 'available', value: 51_878_171 },
    outputTokens: { state: 'available', value: 165_996 },
    reasoningOutputTokens: { state: 'available', value: 55_137 },
    contextTokens: { state: 'available', value: 200_000 },
    contextWindow: { state: 'available', value: 258_000 },
    cacheHitRate: { state: 'available', value: 0.977 },
    apiEquivalentUsd: { state: 'available', value: 64.86123 },
    priceCoverage: { state: 'available', value: 1 },
    pricingCatalogDate: { state: 'available', value: '2026-08-10' },
    pricingSourceUrls: { state: 'available', value: ['https://developers.openai.com/', 'https://learn.chatgpt.com/'] },
    historyComplete: { state: 'available', value: true },
  },
  performance: {
    latestOutputTokensPerSecond: { state: 'available', value: 42.8 },
    latestFirstVisibleResponseMs: { state: 'available', value: 860 },
    cumulativeProcessedDurationMs: { state: 'available', value: 5_760_000 },
  },
  activity: {
    turnCount: { state: 'available', value: 3 },
    modelRequestCount: { state: 'available', value: 364 },
    toolOrCommandCount: { state: 'available', value: 328 },
    retryCount: { state: 'available', value: 0 },
    failedTurnCount: { state: 'available', value: 0 },
  },
  changeSummary: { state: 'available', value: { fileCount: 12, addedLines: 486, deletedLines: 97, complete: true } },
  environment: {
    cwd: { state: 'available', value: '/Users/david/hypha/zeus' },
    branch: { state: 'available', value: 'main' },
    nativeSessionId: { state: 'available', value: '01a02dec-c487-7e41-b555-3bf701effc1c' },
    nativeSessionPath: { state: 'available', value: '/Users/david/.zeus/providers/codex/sessions/2026/08/23/rollout-2026-08-23T17-21-26-01a02dec-c487-7e41-b555-3bf701effc1c.jsonl' },
  },
};

const startingSessionState: NativeSessionState = {
  ...createInitialSessionState(),
  transportState: 'ready',
  conversationState: 'starting_turn',
  projectId: 'project-zeus',
  conversationId: 'motion-starting',
  providerThreadId: 'motion-starting-thread',
};

const coldHistorySessionState: NativeSessionState = {
  ...createInitialSessionState(),
  transportState: 'hydrating',
  conversationState: 'native_idle',
  projectId: 'project-zeus',
  conversationId: 'motion-cold-history',
};

const incompleteFenceItem = motionItem('fence', 'agentMessage', 'in_progress', '正在整理代码：\n\n```ts\nconst focus =', { phase: 'final_answer' }, 'final_answer');
const incompleteTableItem = motionItem('table', 'agentMessage', 'in_progress', '| 状态 | 表现 |\n| --- | --- |\n| 回答中 |', { phase: 'final_answer' }, 'final_answer');
const motionPlanItem = motionItem('plan', 'plan', 'in_progress', '1. 统一活动焦点\n2. 验证减少动态效果');
const motionImageItem = motionItem('image', 'imageGeneration', 'in_progress', '');

const defectConversationId = 'zeus-0323-conversation';
const defectTurnId = 'zeus-0323-turn';
const defectThreadId = 'zeus-0323-thread';

const defectJsonlResource: ConversationResource = {
  id: 'zeus-0323-jsonl',
  projectId: 'project-zeus',
  conversationId: defectConversationId,
  turnId: defectTurnId,
  itemId: 'zeus-0323-user',
  kind: 'attachment',
  presentation: 'card',
  displayName: '2026-08-17T01-31-56-741Z_01a00d58-c5c5-7a83-9336-b8275fee7d64.jsonl',
  attachmentRef: 'conversation.jsonl',
  mimeType: 'application/octet-stream',
  previewKind: 'none',
  iconKind: 'json',
  createdAt: '2026-08-17T01:42:07.957Z',
  updatedAt: '2026-08-17T01:42:07.957Z',
};

const defectImageResource: ConversationResource = {
  id: 'zeus-0323-image',
  projectId: 'project-zeus',
  conversationId: defectConversationId,
  turnId: defectTurnId,
  itemId: 'zeus-0323-user',
  kind: 'attachment',
  presentation: 'card',
  displayName: 'image.png',
  attachmentRef: 'image.png',
  mimeType: 'image/png',
  previewKind: 'image',
  iconKind: 'image',
  createdAt: '2026-08-17T01:42:07.957Z',
  updatedAt: '2026-08-17T01:42:07.957Z',
};

function defectItem(id: string, type: string, text: string, phase = 'prework', resources: ConversationResource[] = []): NativeSessionItemBuffer {
  return {
    key: `zeus-0323:${id}`,
    conversationId: defectConversationId,
    threadId: defectThreadId,
    turnId: defectTurnId,
    itemId: id,
    type,
    status: 'completed',
    phase,
    text,
    payload: phase === 'final_answer' ? { phase: 'final_answer' } : {},
    resources,
    updatedAt: id === 'process' ? '2026-08-17T01:42:03.772Z' : id === 'user' ? '2026-08-17T01:42:07.957Z' : '2026-08-17T02:02:09.433Z',
  };
}

const defectProcessItem = defectItem('process', 'commandExecution', '', 'prework');
defectProcessItem.payload = {
  command: ['rg', 'cache_control'],
  commandActions: [{ type: 'read', path: 'packages/local-server/src/conversationResources.ts' }],
};
const defectUserItem = defectItem('user', 'userMessage', '调用第三方的 Claude 模型时，依旧没有任何缓存命中。', 'prework', [defectJsonlResource, defectImageResource]);
const defectAnswerItem = defectItem('answer', 'agentMessage', '已修复。非图片文件保持文件卡，图片继续显示可预览的缩略图。', 'final_answer');

const taskPushAttachmentKey = 'task-current:defectCurrentState:screenshot';
const taskPushImageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M/wn4GBgYGJAQoAHgQCAfN9NQAAAABJRU5ErkJggg==';
const taskPushImageResource: ConversationResource = {
  id: 'task-push-image-resource',
  projectId: 'project-zeus',
  conversationId: 'task-push-first-frame',
  turnId: 'provider-turn-task-push',
  itemId: 'task-push-user',
  kind: 'attachment',
  presentation: 'card',
  displayName: 'task-push.png',
  attachmentRef: 'task-push-authoritative-ref',
  mimeType: 'image/png',
  previewKind: 'image',
  iconKind: 'image',
  taskPushAttachmentKey,
  createdAt: '2026-08-24T06:16:19.414Z',
  updatedAt: '2026-08-24T06:16:19.414Z',
};
const taskPushUserItem: NativeSessionItemBuffer = {
  key: 'task-push-first-frame:user',
  conversationId: 'task-push-first-frame',
  threadId: 'thread-task-push',
  turnId: 'pending:task-push-submission',
  itemId: 'task-push-user',
  type: 'userMessage',
  status: 'dispatching',
  phase: 'user',
  text: '任务详情内容',
  payload: {
    role: 'user',
    content: '任务详情内容',
    delivery: 'queue',
    taskPushLayout: {
      kind: 'task_push',
      blocks: [
        {
          contextKind: 'current',
          taskId: 'ZEUS-0357',
          taskCode: 'ZEUS-0357',
          taskTitle: '任务详情内容',
          taskType: 'defect',
          taskTypeLabel: '缺陷',
          fields: [{ field: 'defectCurrentState', label: '现状', text: '推送后应立即显示任务提示词和图片。', attachmentKeys: [taskPushAttachmentKey] }],
          attachments: [{ key: taskPushAttachmentKey, field: 'defectCurrentState', name: 'task-push.png', kind: 'image', mimeType: 'image/png', size: 76 }],
          conversationPaths: [],
        },
      ],
      supplementalInfo: '',
      supplementalAttachments: [],
    },
    attachments: [{ name: 'task-push.png', mime: 'image/png', size: 76, kind: 'image', source: 'picker', uploadRef: 'qa-task-push-local-preview', taskPushAttachmentKey }],
  },
  resources: [taskPushImageResource],
  optimistic: true,
  clientUserMessageId: 'client-task-push',
  durableClientUserMessageId: 'client-task-push',
  timelineAt: '2026-08-24T06:16:09.300Z',
  updatedAt: '2026-08-24T06:16:09.300Z',
};
const taskPushReasoningItem: NativeSessionItemBuffer = {
  ...motionItem('task-push-reasoning', 'reasoning', 'in_progress', '正在思考'),
  key: 'task-push-first-frame:reasoning',
  conversationId: 'task-push-first-frame',
  threadId: 'thread-task-push',
  turnId: 'provider-turn-task-push',
  itemId: 'task-push-reasoning',
  timelineAt: '2026-08-24T06:16:12.617Z',
  updatedAt: '2026-08-24T06:16:12.617Z',
};
const taskPushFirstFrameState: NativeSessionState = {
  ...createInitialSessionState(),
  transportState: 'ready',
  conversationState: 'native_running',
  projectId: 'project-zeus',
  conversationId: 'task-push-first-frame',
  providerThreadId: 'thread-task-push',
  items: {
    [taskPushUserItem.key]: taskPushUserItem,
    [taskPushReasoningItem.key]: taskPushReasoningItem,
  },
  itemOrder: [taskPushUserItem.key, taskPushReasoningItem.key],
  turnsByProviderId: {
    'provider-turn-task-push': {
      id: 'provider-turn-task-push',
      providerTurnId: 'provider-turn-task-push',
      submissionId: 'task-push-submission',
      status: 'in_progress',
      error: null,
      plan: null,
      startedAt: '2026-08-24T06:16:12.617Z',
      completedAt: null,
      createdAt: '2026-08-24T06:16:12.617Z',
      updatedAt: '2026-08-24T06:16:12.617Z',
    },
  },
  transcriptRevision: 1,
};

const defectSessionState: NativeSessionState = {
  ...createInitialSessionState(),
  transportState: 'ready',
  conversationState: 'ready',
  projectId: 'project-zeus',
  conversationId: defectConversationId,
  providerThreadId: defectThreadId,
  items: {
    [defectProcessItem.key]: defectProcessItem,
    [defectUserItem.key]: defectUserItem,
    [defectAnswerItem.key]: defectAnswerItem,
  },
  // 故意保留 Provider 过程先于用户消息的落库顺序，核对产品时间线的语义重排。
  itemOrder: [defectProcessItem.key, defectUserItem.key, defectAnswerItem.key],
  turnsByProviderId: {
    [defectTurnId]: {
      id: defectTurnId,
      providerTurnId: defectTurnId,
      submissionId: null,
      status: 'completed',
      startedAt: '2026-08-17T01:42:03.772Z',
      completedAt: '2026-08-17T02:02:09.433Z',
      createdAt: '2026-08-17T01:42:03.772Z',
      updatedAt: '2026-08-17T02:02:09.433Z',
    },
  },
  transcriptRevision: 1,
};

async function loadDefectResourcePreview(resource: ConversationResource): Promise<ConversationResourcePreview> {
  if (resource.id !== defectImageResource.id) throw new Error('非图片资源不提供图片预览。');
  return {
    kind: 'image',
    resource: defectImageResource,
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    byteLength: 68,
  };
}

function ConversationDefectApp() {
  const [taskPushResourceProjected, setTaskPushResourceProjected] = useState(false);
  const projectedTaskPushState: NativeSessionState = {
    ...taskPushFirstFrameState,
    items: {
      ...taskPushFirstFrameState.items,
      [taskPushUserItem.key]: {
        ...taskPushUserItem,
        resources: taskPushResourceProjected ? [taskPushImageResource] : [],
      },
    },
    transcriptRevision: taskPushResourceProjected ? 2 : 1,
  };
  useLayoutEffect(() => {
    if (window.zeus) return;
    Object.defineProperty(window, 'zeus', {
      configurable: true,
      value: {
        getConversationResourcePreview: async () => ({ previewUrl: taskPushImageDataUrl, mimeType: 'image/png' }),
      },
    });
    return () => {
      Reflect.deleteProperty(window, 'zeus');
    };
  }, []);
  return (
    <main className="macos-ai-app zeus-shell session-codex-parity-v1 qa-page qa-defect-page theme-light">
      <header className="qa-heading">
        <p>ZEUS-0323 · 会话时间线与资源布局验收</p>
        <h1>用户消息 → 处理过程 → 最终回答</h1>
      </header>
      <section className="qa-implementation-panel qa-defect-transcript" data-testid="zeus-0323-transcript">
        <ConversationTranscript state={defectSessionState} language="zh-CN" onOpenResource={ignoreResourceOpen} onLoadResourcePreview={loadDefectResourcePreview} />
      </section>
      <section className="qa-implementation-panel qa-defect-transcript" data-testid="task-push-first-frame">
        <h2>任务推送首帧</h2>
        <p>Provider turn 已先到，仍应先显示用户任务提示词；权威资源投影到达后继续沿用本地图片预览。</p>
        <button type="button" onClick={() => setTaskPushResourceProjected((value) => !value)}>
          {taskPushResourceProjected ? '移除权威资源投影' : '模拟权威资源投影到达'}
        </button>
        <output data-testid="task-push-resource-state">{taskPushResourceProjected ? '权威资源已到达' : '仅本地提交快照'}</output>
        <ConversationTranscript state={projectedTaskPushState} language="zh-CN" onLoadResourcePreview={loadDefectResourcePreview} />
      </section>
    </main>
  );
}

function MotionPreview(props: { dark?: boolean }) {
  const theme = props.dark ? 'theme-dark' : 'theme-light';
  const [flowLatest, setFlowLatest] = useState(false);
  return (
    <section className={`macos-ai-app session-codex-parity-v1 qa-motion-theme ${theme}`} data-testid={props.dark ? 'motion-dark' : 'motion-light'}>
      <header>
        <strong>{props.dark ? '深色主题' : '浅色主题'}</strong>
        <small>正文单焦点与会话加载状态</small>
      </header>
      <div className="qa-motion-transcript ai-workspace" data-testid="motion-single-focus">
        <ConversationTranscript state={motionSessionState} language="zh-CN" />
      </div>
      <div className="qa-motion-grid">
        <section className="qa-motion-activity-flow">
          <header>
            <div>
              <h3>活动行连续更新</h3>
              <small>同一思考状态换条目、移动到底部时保留节点与动效</small>
            </div>
            <button type="button" onClick={() => setFlowLatest((value) => !value)}>
              {flowLatest ? '恢复中间位置' : '推进到底部'}
            </button>
          </header>
          <div className="ai-workspace" data-testid="motion-active-flow">
            <ConversationTranscript state={activityFlowState(flowLatest)} language="zh-CN" />
          </div>
        </section>
        <section>
          <h3>等待思考</h3>
          <ConversationTranscript state={startingSessionState} language="zh-CN" />
        </section>
        <section>
          <h3>计划与图片</h3>
          <PlanSummary item={motionPlanItem} language="zh-CN" motionActive />
          <ThreadItemView item={motionImageItem} language="zh-CN" motionActive />
        </section>
        <section>
          <h3>未闭合结构</h3>
          <ThreadItemView item={incompleteFenceItem} language="zh-CN" motionActive />
          <ThreadItemView item={incompleteTableItem} language="zh-CN" motionActive />
        </section>
        <section>
          <h3>功能型加载</h3>
          <div className="qa-motion-functional-row">
            <span className="session-command-spinner" aria-hidden="true" />
            <span className="browser-tab-loading" aria-hidden="true" />
            <span className="session-workspace-root" aria-hidden="true">
              <span className="session-subagent-status-dot" data-status="running" />
            </span>
            <span>提交、浏览器、子代理</span>
          </div>
          <div className="session-reconnect-notice">
            <span className="session-reconnect-symbol" aria-hidden="true">
              <ArrowsClockwise />
            </span>
            <span>正在恢复连接</span>
          </div>
          <div className="browser-workspace browser-workspace-loading" data-loading="true">
            <GlobeSimple aria-hidden="true" />
            <p>正在打开内置浏览器…</p>
          </div>
        </section>
        <section className="qa-motion-loading">
          <h3>冷加载骨架</h3>
          <div className="qa-motion-cold-history ai-workspace" data-testid="motion-cold-history">
            <ConversationTranscript state={coldHistorySessionState} language="zh-CN" historyLoading />
          </div>
        </section>
      </div>
    </section>
  );
}

function SendScrollPreview() {
  const [state, setState] = useState(sendScrollInitialState);
  const [sendCount, setSendCount] = useState(0);
  const [scrollMetrics, setScrollMetrics] = useState('等待测量');

  useLayoutEffect(() => {
    const transcript = document.querySelector<HTMLElement>('[data-testid="send-scroll-preview"] .session-transcript');
    if (!transcript) return;
    const distance = Math.max(0, transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop);
    setScrollMetrics(`scrollTop ${Math.round(transcript.scrollTop)} / max ${Math.round(transcript.scrollHeight - transcript.clientHeight)}，距底部 ${Math.round(distance)}px`);
  }, [state]);

  function sendImmediately(): void {
    const clientUserMessageId = `qa-send-${sendCount + 1}`;
    const startedAt = new Date().toISOString();
    setState((previous) => {
      const started = sessionReducer(previous, {
        type: 'send_started',
        clientUserMessageId,
        durableClientUserMessageId: clientUserMessageId,
        draft: `第 ${sendCount + 1} 条新消息，应立即出现在底部。`,
        attachments: [],
        submittedAttachments: [],
        browserSubmission: null,
        contextDraft: previous.contextDraft,
        browserComments: [],
        delivery: 'steer_now',
        previousConversationState: previous.conversationState,
        startedAt,
      });
      // 模拟极快的 accepted/完成路径，验证不依赖 awaitingReply 列表也会立即到底。
      return sessionReducer(started, {
        type: 'send_accepted',
        clientUserMessageId,
        status: 'completed',
        providerTurnId: sendScrollTurnId,
      });
    });
    setSendCount((value) => value + 1);
  }

  return (
    <section className="qa-motion-send-preview session-codex-parity-v1" data-testid="send-scroll-preview">
      <div>
        <h3>发送后自动到底</h3>
        <button type="button" data-testid="send-scroll-button" onClick={sendImmediately}>
          发送新消息
        </button>
      </div>
      <small data-testid="send-scroll-metrics">{scrollMetrics}</small>
      <div className="qa-send-transcript ai-workspace">
        <ConversationTranscript state={state} language="zh-CN" />
      </div>
    </section>
  );
}

function HistoryPagingPreview() {
  return (
    <section className="qa-motion-send-preview session-codex-parity-v1" data-testid="history-paging-preview">
      <div>
        <h3>向上读取历史消息</h3>
        <small>加载状态覆盖在滚动区顶部，不参与消息排版。</small>
      </div>
      <div className="qa-send-transcript ai-workspace">
        <ConversationTranscript state={historyPagingSessionState} language="zh-CN" />
      </div>
    </section>
  );
}

function ExecutionPhasePreview() {
  const [appended, setAppended] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [historyOnly, setHistoryOnly] = useState(false);
  const terminal = completed || historyOnly;
  const state = executionPhaseState({ appended, completed: terminal });
  return (
    <section className="qa-motion-theme session-codex-parity-v1 theme-light" data-testid="execution-phase-preview" data-phase-state={historyOnly ? 'history' : completed ? 'completed' : 'running'}>
      <header>
        <strong>单轮稳定活动组</strong>
        <small>40+ 条命令、文件、搜索、网页和工具活动只生成一个固定在首个操作位置的活动组。</small>
      </header>
      <div className="qa-motion-fixture-actions">
        <button type="button" data-testid="execution-phase-append" onClick={() => setAppended(true)} disabled={appended}>
          {appended ? '已追加第 41 条操作' : '增量追加第 41 条操作'}
        </button>
        <button type="button" data-testid="execution-phase-complete" onClick={() => setCompleted((value) => !value)}>
          {completed ? '恢复运行态' : '切换为完成态'}
        </button>
        <button type="button" data-testid="execution-phase-history" onClick={() => setHistoryOnly((value) => !value)}>
          {historyOnly ? '退出历史投影' : '切换为历史投影'}
        </button>
        <output data-testid="execution-phase-state">
          {historyOnly ? '历史投影' : completed ? '完成态' : '运行态'} · {appended ? 41 : 40} 条操作
        </output>
      </div>
      <div className="qa-motion-transcript ai-workspace">
        <ConversationTranscript state={state} language="zh-CN" historyOnly={historyOnly} />
      </div>
    </section>
  );
}

function LongScrollPreview() {
  const [expanded, setExpanded] = useState(false);
  const [scrollAction, setScrollAction] = useState('尚未移动');

  function moveTranscript(mode: 'middle' | 'up'): void {
    const transcript = document.querySelector<HTMLElement>('[data-testid="long-scroll-preview"] .session-transcript');
    if (!transcript) return;
    const maximum = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
    transcript.scrollTop = mode === 'middle' ? Math.round(maximum * 0.55) : Math.max(0, transcript.scrollTop - 620);
    transcript.dispatchEvent(new Event('scroll', { bubbles: true }));
    setScrollAction(mode === 'middle' ? '已移动到中段' : '已向上移动 620px');
  }

  return (
    <section className="qa-motion-send-preview session-codex-parity-v1" data-testid="long-scroll-preview">
      <div>
        <div>
          <h3>72 条混合高度消息上滚</h3>
          <small>第 25 条延迟增高时，前台第一条可见稳定行必须保持原位。</small>
        </div>
        <div className="qa-motion-fixture-actions">
          <button type="button" data-testid="long-scroll-middle" onClick={() => moveTranscript('middle')}>
            移动到中段
          </button>
          <button type="button" data-testid="long-scroll-up" onClick={() => moveTranscript('up')}>
            向上移动 620px
          </button>
          <button type="button" data-testid="long-scroll-resize" onClick={() => setExpanded((value) => !value)}>
            {expanded ? '恢复第 25 条高度' : '延迟增高第 25 条'}
          </button>
        </div>
      </div>
      <output data-testid="long-scroll-height-state">
        {expanded ? '第 25 条已增高' : '第 25 条为基础高度'} · {scrollAction}
      </output>
      <div className="qa-send-transcript qa-long-scroll-transcript ai-workspace">
        <ConversationTranscript state={longScrollState(expanded)} language="zh-CN" />
      </div>
    </section>
  );
}

function NoRefillPreview() {
  const lateFailure = lateFailureNoRefillState();
  const restartFailure = restartFailureNoRefillState();
  return (
    <section className="qa-motion-send-preview session-codex-parity-v1" data-testid="no-refill-preview">
      <div>
        <h3>失败消息不回填输入框</h3>
        <small>即时/迟到失败和重启恢复都只保留消息气泡与失败审计。</small>
      </div>
      <dl className="qa-no-refill-results">
        <div data-testid="late-failure-result">
          <dt>迟到失败</dt>
          <dd data-draft={lateFailure.draft} data-attachment-count={lateFailure.attachments.length}>
            {lateFailure.draft} · {lateFailure.attachments.map((attachment) => attachment.name).join('、')}
          </dd>
        </div>
        <div data-testid="restart-failure-result">
          <dt>重启恢复</dt>
          <dd data-draft={restartFailure.draft} data-attachment-count={restartFailure.attachments.length}>
            {restartFailure.draft || '空输入框'} · {restartFailure.attachments.length} 个附件
          </dd>
        </div>
      </dl>
      <div className="qa-send-transcript ai-workspace">
        <ConversationTranscript state={lateFailure} language="zh-CN" />
      </div>
    </section>
  );
}

const errorContractFixtures = [
  { id: 'account', code: 'ZEUS_CODEX_RPC_TIMEOUT', message: 'Codex app-server request timed out: account/read' },
  { id: 'thread', code: 'ZEUS_CODEX_RPC_TIMEOUT', message: 'Codex app-server request timed out: thread/read' },
  { id: 'plan', code: 'ZEUS_PLAN_CONFIRMATION_FAILED', message: 'Plan confirmation failed.' },
  { id: 'queue', code: 'ZEUS_NATIVE_QUEUE_FAILED', message: 'Queue submission failed.' },
  { id: 'steer', code: 'ZEUS_NATIVE_STEER_FAILED', message: 'Steering submission failed.' },
  { id: 'recovery', code: 'ZEUS_NATIVE_SUBMISSION_NOT_DISPATCHED', message: 'The submission was not dispatched to the provider.' },
] as const;

function ErrorContractPreview() {
  return (
    <section className="qa-motion-send-preview session-codex-parity-v1" data-testid="error-contract-preview">
      <div>
        <h3>全应用错误直出</h3>
        <small>每个出口只有脱敏后的一行“错误码: 原始消息”；全局弹窗只保留必要操作。</small>
      </div>
      <div className="qa-error-contract-lines">
        {errorContractFixtures.map((error) => (
          <p key={error.id} data-testid={`error-line-${error.id}`}>
            <VisibleApplicationError error={error} language="zh-CN" />
          </p>
        ))}
      </div>
      <div className="qa-motion-fixture-actions">
        <button type="button" data-testid="error-dialog-trigger" onClick={() => reportApplicationError(errorContractFixtures[0], { language: 'zh-CN' })}>
          打开全局错误弹窗
        </button>
        <button
          type="button"
          data-testid="fatal-error-dialog-trigger"
          onClick={() => reportApplicationError(new Error('Renderer crashed while rendering workspace.'), { language: 'zh-CN', primaryAction: { label: '刷新窗口', run: () => undefined } })}
        >
          模拟致命错误
        </button>
      </div>
    </section>
  );
}

function DeliveryFailurePreview() {
  return (
    <section className="qa-motion-send-preview session-codex-parity-v1" data-testid="delivery-failure-preview">
      <div>
        <h3>失败消息原始错误直出</h3>
        <small>不显示状态标题、解释、恢复建议或技术详情，也不回填输入框。</small>
      </div>
      <div className="qa-send-transcript ai-workspace">
        <ConversationTranscript state={deliveryFailureSessionState} language="zh-CN" />
      </div>
    </section>
  );
}

function SteeringPreview() {
  const state = steeringInitialState;
  const steeringState = state.queue?.submissions.find((entry) => entry.id === steeringSubmission.id)?.status;

  return (
    <section className="qa-motion-send-preview session-codex-parity-v1" data-testid="steering-preview">
      <div>
        <h3>排队消息引导立即接管</h3>
        <small data-testid="steering-status">{steeringState === 'steering' ? '引导中，消息保留在队列，等待当前轮次确认' : state.queue?.submissions.length ? '排队中' : '已按正常引导进入当前思考过程'}</small>
      </div>
      <div className="qa-send-transcript ai-workspace">
        <ConversationTranscript state={state} language="zh-CN" />
      </div>
    </section>
  );
}

interface MotionDiagnosticsSnapshot {
  viewport: string;
  reducedMotion: string;
  focusAnimations: string;
  focusAnimationDurations: string;
  tailAnchor: string;
  tailSize: string;
  tailAnimation: string;
  reasoningAnimation: string;
  activityAnimation: string;
}

function MotionDiagnostics() {
  const [snapshot, setSnapshot] = useState<MotionDiagnosticsSnapshot | null>(null);

  useLayoutEffect(() => {
    const transcript = document.querySelector<HTMLElement>("[data-testid='motion-light'] [data-testid='motion-active-flow']");
    const tailAnchor = transcript?.querySelector<HTMLElement>("[data-streaming-tail-anchor='true']") ?? null;
    const tailStyle = tailAnchor ? window.getComputedStyle(tailAnchor, '::after') : null;
    const activityIcon = transcript?.querySelector<HTMLElement>('.session-activity-item-icon') ?? null;
    const reasoningText = document.querySelector<HTMLElement>("[data-testid='execution-phase-preview'] .session-reasoning-summary[data-status='active'] > .zeus-fidelity-text") ?? null;
    const reasoningStyle = reasoningText ? window.getComputedStyle(reasoningText) : null;
    const focusAnimationNames = [tailStyle?.animationName, activityIcon ? window.getComputedStyle(activityIcon).animationName : null].filter((name): name is string => Boolean(name && name !== 'none'));
    const focusAnimationDurations = [tailStyle?.animationDuration, activityIcon ? window.getComputedStyle(activityIcon).animationDuration : null].filter((duration): duration is string => Boolean(duration && duration !== '0s'));
    setSnapshot({
      viewport: `${window.innerWidth}×${window.innerHeight}`,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? '开启' : '关闭',
      focusAnimations: `${focusAnimationNames.length}（${focusAnimationNames.join('、') || '无'}）`,
      focusAnimationDurations: focusAnimationDurations.join('、') || '无',
      tailAnchor: tailAnchor?.tagName.toLocaleLowerCase() ?? '未找到',
      tailSize: tailStyle ? `${tailStyle.inlineSize} × ${tailStyle.blockSize}` : '未找到',
      tailAnimation: tailStyle?.animationName ?? '未找到',
      reasoningAnimation: reasoningStyle ? `${reasoningStyle.animationName} · ${reasoningStyle.animationDuration}` : '未找到',
      activityAnimation: activityIcon ? window.getComputedStyle(activityIcon).animationName : '未找到',
    });
  }, []);

  if (!snapshot) return <p role="status">正在读取真实 DOM 计算样式…</p>;
  return (
    <section className="qa-motion-diagnostics" data-testid="motion-diagnostics" aria-label="真实 DOM 诊断">
      <h2>真实 DOM 诊断</h2>
      <dl>
        {Object.entries(snapshot).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function MotionApp() {
  return (
    <main className="macos-ai-app zeus-shell qa-page qa-motion-page">
      <header className="qa-heading">
        <p>ZEUS-0307 · 真实 DOM 动效验收</p>
        <h1>会话进行中的活动焦点</h1>
      </header>
      <MotionDiagnostics />
      <MotionPreview />
      <MotionPreview dark />
      <ExecutionPhasePreview />
      <SendScrollPreview />
      <DeliveryFailurePreview />
      <HistoryPagingPreview />
      <LongScrollPreview />
      <NoRefillPreview />
      <ErrorContractPreview />
      <SteeringPreview />
      <ConversationSelectionRecoveryPreview />
      <StopButtonPreview />
      <section className="qa-motion-theme session-codex-parity-v1 theme-light" data-testid="runtime-details-horizontal">
        <h2>运行详情横向分组</h2>
        <RuntimeDetails runtime={runtimeDetailsFixture} language="zh-CN" scope="session" />
      </section>
      <ApplicationErrorDialogHost language="zh-CN" />
    </main>
  );
}

function StopButtonPreview() {
  const [pausing, setPausing] = useState(false);
  return (
    <section className="qa-motion-theme session-codex-parity-v1 theme-light" data-testid="stop-button-preview">
      <header>
        <strong>停止响应</strong>
        <small>点击后进入明确的暂停中状态，不再显示灰色实心圆。</small>
      </header>
      <ConversationComposer
        state={{ ...motionSessionState, busyOperation: pausing ? 'interrupt' : null }}
        language="zh-CN"
        onDraftChange={() => undefined}
        onSubmit={() => undefined}
        onInterrupt={() => setPausing(true)}
        permissionMode="auto"
        collaborationMode="default"
      />
    </section>
  );
}

const selectionRecoveryPlan = {
  explanation: '切回活动会话后继续显示实时计划进度。',
  steps: [
    { step: '恢复实时订阅', status: 'completed' as const },
    { step: '继续接收正文与进度', status: 'in_progress' as const },
  ],
};

function ConversationSelectionRecoveryPreview() {
  const [selected, setSelected] = useState<'idle' | 'running'>('idle');
  const selectedConversation = selected === 'running' ? { ...runningConversation, stage: 'running' as const, listRuntimeState: 'streaming' as const } : { ...unreadConversation, stage: 'ready' as const, listRuntimeState: 'ready' as const };
  const presentation = resolveNativeConversationSelectionPresentation(selectedConversation, selectedConversation.listRuntimeState);
  return (
    <section className="qa-motion-theme session-codex-parity-v1 theme-light" data-testid="conversation-selection-recovery">
      <header>
        <strong>切换回会话后的实时恢复</strong>
        <small>活动会话恢复交互态；空闲会话保持轻量历史态</small>
      </header>
      <div>
        <button type="button" onClick={() => setSelected('idle')}>
          选择空闲会话
        </button>
        <button type="button" onClick={() => setSelected('running')}>
          选择活动会话
        </button>
      </div>
      <output data-testid="conversation-selection-presentation">{presentation}</output>
      {presentation === 'interactive' ? <SessionPlanProgress plan={selectionRecoveryPlan} language="zh-CN" /> : null}
    </section>
  );
}

const commandRequest: NativePendingRequest = {
  id: 'command-approval',
  conversationId: 'approval',
  turnId: 'turn-approval',
  itemId: 'item-command',
  generationId: 'generation-qa',
  type: 'command',
  status: 'pending',
  payload: {
    command: ['/opt/homebrew/bin/pnpm', 'package:mac'],
    cwd: '/Users/david/hypha/zeus',
    reason: '是否允许在沙箱外执行生产构建验收？需要访问真实依赖并确认可交付制品能够生成。',
    availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['/opt/homebrew/bin/pnpm', 'package:mac'] } }, 'decline', 'cancel'],
  },
  response: null,
  containsSecret: false,
  expiresAt: null,
  createdAt: '2026-07-22T08:05:00.000Z',
  resolvedAt: null,
};

const userInputRequest: NativePendingRequest = {
  id: 'user-input-with-optional-metadata',
  conversationId: 'input',
  turnId: 'turn-input',
  itemId: 'item-input',
  generationId: 'generation-qa',
  type: 'request_user_input',
  status: 'pending',
  payload: {
    threadId: 'thread-input',
    turnId: 'turn-input',
    itemId: 'item-input',
    questions: [
      {
        id: 'progress_copy',
        header: '百分比显示',
        question: '下载更新时，进度区域应保留哪些信息？',
        options: [
          { label: '容量与百分比', description: '同时显示已下载容量、总容量和整数百分比。' },
          { label: '仅百分比', description: '只显示整数百分比，界面更简洁。' },
        ],
        isOther: true,
        isSecret: false,
      },
    ],
    isBlocking: false,
    autoResolutionMs: null,
    providerMetadataAddedLater: { ignoredByQuestionRenderer: true },
  },
  response: null,
  containsSecret: false,
  expiresAt: null,
  createdAt: '2026-08-11T03:54:15.000Z',
  resolvedAt: null,
};

function ReferencePanel(props: { title: string; src: string; className?: string }) {
  return (
    <section className={`qa-reference-panel ${props.className ?? ''}`}>
      <h2>{props.title}</h2>
      <img src={`${referenceBase}/${props.src}`} alt={props.title} />
    </section>
  );
}

function App() {
  return (
    <main className="macos-ai-app zeus-shell session-codex-parity-v1 qa-page" data-theme="light">
      <header className="qa-heading">
        <p>2026-07-22 · 同视口视觉验收</p>
        <h1>Codex 会话列表与审批面板</h1>
      </header>

      <section className="qa-comparison qa-list-comparison">
        <div className="qa-reference-stack">
          <ReferencePanel title="参考：会话进行中 / 完成未读" src="codex-clipboard-f7c40e26-5276-4c78-aa00-386300113583.png" />
          <ReferencePanel title="参考：等待批准" src="codex-clipboard-a4e8a229-5518-4829-ab0d-1dbe7d85e515.png" className="qa-reference-wide-crop" />
        </div>
        <section className="qa-implementation-panel" data-testid="conversation-implementation">
          <h2>Zeus 实现</h2>
          <div className="session-list-pane qa-session-list">
            <ProjectConversationTree groups={groups} selectedConversationId="approval" conversationStates={conversationStates} onSelectConversation={() => undefined} onStartConversation={() => undefined} language="zh-CN" />
          </div>
        </section>
      </section>

      <section className="qa-comparison qa-approval-comparison">
        <ReferencePanel title="参考：命令审批与类似命令菜单" src="codex-clipboard-a4e8a229-5518-4829-ab0d-1dbe7d85e515.png" />
        <section className="qa-implementation-panel" data-testid="approval-implementation">
          <h2>Zeus 实现</h2>
          <PendingRequestSurface request={commandRequest} language="zh-CN" permissionMode="auto" onRespond={() => undefined} autoFocus={false} />
        </section>
      </section>

      <section className="qa-comparison qa-approval-comparison">
        <section className="qa-implementation-panel" data-testid="user-input-implementation">
          <h2>真实请求结构：带 isBlocking 元数据</h2>
          <PendingRequestSurface request={userInputRequest} language="zh-CN" permissionMode="auto" onRespond={() => undefined} autoFocus={false} />
        </section>
      </section>

      <section className="qa-implementation-panel qa-resource-implementation" data-testid="inline-resource-implementation">
        <h2>会话正文：可打开资源与不可用引用</h2>
        <div className="ai-workspace">
          <SafeMarkdown text={inlineResourceMarkdown} language="zh-CN" resources={inlineResourceItems} onOpenResource={ignoreResourceOpen} />
        </div>
      </section>
    </main>
  );
}

const motionQa = new URLSearchParams(window.location.search).has('motion');
const defectQa = new URLSearchParams(window.location.search).has('zeus0323');
// 开发态热更新复用同一根节点，避免视觉验收页重复挂载并制造无关控制台错误。
const qaRoot = window.__zeusSessionStylesRoot ?? createRoot(document.getElementById('root')!);
window.__zeusSessionStylesRoot = qaRoot;
qaRoot.render(defectQa ? <ConversationDefectApp /> : motionQa ? <MotionApp /> : <App />);
