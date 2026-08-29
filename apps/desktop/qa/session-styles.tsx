import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { GlobeSimpleIcon as GlobeSimple } from '@phosphor-icons/react/dist/csr/GlobeSimple';
import '../src/renderer/styles.css';
import '../src/renderer/session/session.css';
import './session-styles.css';
import type { ConversationResource, ConversationResourcePreview } from '@zeus/shared';
import { PendingRequestSurface } from '../src/renderer/session/PendingRequestSurface.js';
import { type ConversationTreeRuntimeState, type ProjectConversationGroup, ProjectConversationTree } from '../src/renderer/session/ProjectConversationTree.js';
import type {
  CodexTaskPushCapabilities,
  NativeConversationAttachment,
  NativeConversationChoice,
  NativeConversationSnapshot,
  NativePendingRequest,
  NativeQueuedSubmission,
  NativeRuntimeDetailsSnapshot,
  NativeSessionItemBuffer,
  NativeSessionState,
  NativeSubagentListSnapshot,
  NativeSubagentThreadSnapshot,
} from '../src/renderer/session/sessionTypes.js';
import { copyText as copyTranscriptText, ThreadItemView } from '../src/renderer/session/ThreadItemView.js';
import { ConversationMarkdown } from '../src/renderer/session/ConversationMarkdown.js';
import { ConversationTranscript } from '../src/renderer/session/ConversationTranscript.js';
import { BrowserWorkspace } from '../src/renderer/session/BrowserWorkspace.js';
import { ConversationComposer } from '../src/renderer/session/ConversationComposer.js';
import { PlanSummary } from '../src/renderer/session/PlanSummary.js';
import { RuntimeDetails } from '../src/renderer/session/RuntimeDetails.js';
import { SubagentWorkspace } from '../src/renderer/session/SubagentWorkspace.js';
import { defaultSourceWorkspaceViewMode, SourceWorkspace } from '../src/renderer/session/SourceWorkspace.js';
import { SessionPlanProgress } from '../src/renderer/session/SessionActivity.js';
import { createInitialSessionState, sessionReducer } from '../src/renderer/session/sessionReducer.js';
import { createSessionController, type SessionControllerClient } from '../src/renderer/session/useSessionController.js';
import { reconcileConversationHistoryCache } from '../src/renderer/session/conversationSnapshotV2Adapter.js';
import { resolveNativeConversationSelectionPresentation } from '../src/renderer/features/workspace/workspaceSupport.js';
import { ApplicationErrorDialogHost, reportApplicationError, VisibleApplicationError } from '../src/renderer/ui/ApplicationErrorDialog.js';
import type { TaskRecord } from '../src/renderer/apiClient.js';
import { type TaskModelPushForm, TaskModelPushModal, type TaskModelPushModalStatus } from '../src/renderer/task/TaskModelPushModal.js';

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
const executionPhaseSummaryA = motionItem('phase-summary-a', 'agentMessage', 'completed', 'A 摘要：先读取两个分支的提交与文件差异，再决定是否需要暂存保护现有未提交实现。', { phase: 'commentary' }, 'commentary');
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
const executionPhaseCommentary = motionItem('phase-commentary', 'agentMessage', 'completed', 'B 摘要：已确认来源分支与当前分支的共同基线，现在执行合并并保留两边入口。', { phase: 'commentary' }, 'commentary');
const executionPhaseLaterReasoning = motionItem('phase-reasoning-later', 'reasoning', 'in_progress', '继续核对 32 条阈值后的稳定分组。', {
  summary: ['继续核对 32 条阈值后的稳定分组。'],
});
const executionPhaseSummaryC = motionItem('phase-summary-c', 'agentMessage', 'completed', 'C 摘要：合并已经完成；接下来审查稳定身份、执行快照与原生投影链路。', { phase: 'commentary' }, 'commentary');
const executionPhaseAppendedActivity = motionItem('phase-appended-tool', 'dynamicToolCall', 'in_progress', '', { toolName: 'browser' });
const executionPhaseFinalAnswer = motionItem('phase-final-answer', 'agentMessage', 'completed', '本轮过程已完成。完成态默认只显示这一条最终正文、交付文件与处理耗时。', { phase: 'final_answer' }, 'final_answer');
const executionPhaseDeliveryFile: NativeSessionItemBuffer = {
  ...motionItem('phase-delivery-file', 'agentMessage', 'completed', '查看 [会话处理过程验收.md](docs/会话处理过程验收.md)', { phase: 'final_answer' }, 'final_answer'),
  resources: [
    {
      id: 'phase-delivery-file-resource',
      projectId: 'project-zeus',
      conversationId: motionConversationId,
      turnId: motionTurnId,
      itemId: 'phase-delivery-file',
      kind: 'file',
      presentation: 'inline',
      delivery: 'assistant',
      displayName: '会话处理过程验收.md',
      projectRelativePath: 'docs/会话处理过程验收.md',
      mimeType: 'text/markdown',
      iconKind: 'markdown',
      createdAt: '2026-08-15T04:01:00.000Z',
      updatedAt: '2026-08-15T04:01:00.000Z',
    },
  ],
};
const interruptedQueueTakeoverText = '第二条引导消息（存量 interrupted 接管）';
const interruptedQueueTakeoverDurableItem: NativeSessionItemBuffer = {
  ...motionItem('phase-queue-takeover', 'userMessage', 'completed', interruptedQueueTakeoverText, { role: 'user', content: interruptedQueueTakeoverText, delivery: 'queue' }, 'user'),
  providerItemId: 'phase-queue-takeover-provider-item',
  clientUserMessageId: 'phase-queue-takeover-provider-client',
  durableClientUserMessageId: 'phase-queue-takeover-provider-client',
  optimistic: false,
};
const interruptedQueueTakeoverSubmission: NativeQueuedSubmission = {
  id: 'phase-queue-takeover-interrupted',
  conversationId: motionConversationId,
  content: interruptedQueueTakeoverText,
  status: 'paused',
  delivery: 'queue',
  position: 0,
  providerTurnId: null,
  clientUserMessageId: 'phase-queue-takeover-legacy-client',
  pausedReason: 'interrupted',
  error: null,
  createdAt: '2026-08-15T03:40:00.000Z',
  updatedAt: '2026-08-15T04:00:00.300Z',
};

function executionPhaseState(options: { appended: boolean; completed: boolean }): NativeSessionState {
  const baseActivities = options.completed ? executionPhaseActivities.map((item) => ({ ...item, status: 'completed' })) : executionPhaseActivities;
  const items = [
    ...(options.completed ? [interruptedQueueTakeoverDurableItem] : []),
    executionPhaseSummaryA,
    executionPhasePreviousReasoning,
    ...baseActivities.slice(0, 12),
    executionPhaseCommentary,
    executionPhaseReasoning,
    ...baseActivities.slice(12, 33),
    executionPhaseSummaryC,
    executionPhaseLaterReasoning,
    ...baseActivities.slice(33),
    ...(options.appended ? [{ ...executionPhaseAppendedActivity, status: options.completed ? 'completed' : 'in_progress' }] : []),
    ...(options.completed ? [executionPhaseFinalAnswer, executionPhaseDeliveryFile] : []),
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
    queue: options.completed
      ? {
          state: { type: 'paused', reason: 'interrupted' },
          waitReason: 'interrupted',
          submissions: [interruptedQueueTakeoverSubmission],
        }
      : null,
    transcriptRevision: 40 + Number(options.appended) + Number(options.completed),
  };
}

const interruptedExecutionPhaseState: NativeSessionState = (() => {
  const state = executionPhaseState({ appended: true, completed: false });
  return {
    ...state,
    conversationState: 'ready',
    activeTurnId: null,
    turnsByProviderId: {
      [motionTurnId]: {
        ...state.turnsByProviderId[motionTurnId]!,
        status: 'interrupted',
        completedAt: '2026-08-15T04:01:00.000Z',
        updatedAt: '2026-08-15T04:01:00.000Z',
      },
    },
    terminalTurnIds: { [motionTurnId]: 'interrupted' },
    transcriptRevision: 43,
  };
})();

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
      history: { nextCursor: 'history-page-2', hasMore: true, loading: false, error: null, loadedThroughSequence: 96, oldestLoadedSequence: 49 },
      historyByTurn: {},
      processByTurn: {},
      resources: { nextCursor: null, hasMore: false, loading: false, loaded: true, error: null, items: [] },
      changeSetsByTurn: {},
    },
  } as NonNullable<NativeSessionState['snapshot']>,
  items: Object.fromEntries(historyPagingItems.map((item) => [item.key, item])),
  itemOrder: historyPagingItems.map((item) => item.key),
};

const completeMessageHandle = 'qa-complete-message-handle';
const completeMessageEndMarker = '【完整消息结尾：ZEUS-0369】';
const completeMessageText = `${Array.from({ length: 52 }, (_, index) => `完整回答第 ${index + 1} 段：打开会话时可以先显示有界预览，但必须继续读取正文，不能把预览冒充最终回答。`).join('\n\n')}\n\n${completeMessageEndMarker}`;
const completeMessageCodePoints = Array.from(completeMessageText);
const completeMessagePageBoundary = 1_300;
const completeMessageItem: NativeSessionItemBuffer = {
  ...motionItem(
    'complete-message',
    'agentMessage',
    'completed',
    `${completeMessageText.slice(0, 2_048)}…`,
    {
      phase: 'final_answer',
      v2ContentKind: 'model_history',
      v2Sequence: 96,
      v2ContentHandle: completeMessageHandle,
      v2ContentTruncated: true,
      v2ContentBytes: new TextEncoder().encode(completeMessageText).byteLength,
    },
    'final_answer',
  ),
  conversationId: 'complete-message-conversation',
  threadId: 'complete-message-thread',
  turnId: 'complete-message-turn',
};
const completeMessageSessionState: NativeSessionState = {
  ...createInitialSessionState(),
  transportState: 'ready',
  conversationState: 'ready',
  projectId: 'project-zeus',
  conversationId: completeMessageItem.conversationId,
  providerThreadId: completeMessageItem.threadId,
  snapshot: {
    id: completeMessageItem.conversationId,
    projectId: 'project-zeus',
    items: [
      {
        id: completeMessageItem.itemId,
        turnId: completeMessageItem.turnId,
        providerItemId: null,
        type: completeMessageItem.type,
        status: completeMessageItem.status,
        phase: completeMessageItem.phase,
        text: completeMessageItem.text,
        payload: completeMessageItem.payload,
        resources: [],
        startedAt: completeMessageItem.updatedAt ?? null,
        completedAt: completeMessageItem.updatedAt ?? null,
        updatedAt: completeMessageItem.updatedAt ?? '2026-08-28T00:00:00.000Z',
      },
    ],
    snapshotV2: { structureGeneration: '2026-08-21-conversation-snapshot-v2', activeTurn: null, recentClosedTurns: [] },
  } as NonNullable<NativeSessionState['snapshot']>,
  items: { [completeMessageItem.key]: completeMessageItem },
  itemOrder: [completeMessageItem.key],
  transcriptRevision: 1,
};

function historyPagingRangeSnapshot(input: { through: number; oldest: number; cursor: string; hasMore: boolean }): NativeConversationSnapshot {
  return {
    id: historyPagingConversationId,
    items: [],
    snapshotV2: {
      structureGeneration: '2026-08-21-conversation-snapshot-v2',
    },
    v2Paging: {
      history: {
        nextCursor: input.cursor,
        hasMore: input.hasMore,
        loading: false,
        error: null,
        loadedThroughSequence: input.through,
        oldestLoadedSequence: input.oldest,
      },
    },
  } as unknown as NativeConversationSnapshot;
}

const historyPagingCachedRange = historyPagingRangeSnapshot({ through: 96, oldest: 1, cursor: 'cached-deepest', hasMore: false });
const historyPagingRangeEvidence = {
  sameHighWater: reconcileConversationHistoryCache(historyPagingCachedRange, historyPagingRangeSnapshot({ through: 96, oldest: 49, cursor: 'fresh-tail', hasMore: true })).snapshot.v2Paging?.history.nextCursor,
  overlappingTail: reconcileConversationHistoryCache(historyPagingCachedRange, historyPagingRangeSnapshot({ through: 120, oldest: 73, cursor: 'fresh-overlap', hasMore: true })).snapshot.v2Paging?.history.nextCursor,
  disconnectedTail: reconcileConversationHistoryCache(historyPagingCachedRange, historyPagingRangeSnapshot({ through: 200, oldest: 153, cursor: 'fresh-gap', hasMore: true })).snapshot.v2Paging?.history.nextCursor,
};

function earlierHistoryPagingItems(page: number): NativeSessionItemBuffer[] {
  return Array.from({ length: 4 }, (_, index) => {
    const sequence = 48 - (page - 2) * 4 - index;
    return {
      ...motionItem(`history-page-${page}-${sequence}`, 'agentMessage', 'completed', `更早回答 ${sequence}：分页前插后当前可见消息应保持原位。`, {
        phase: 'final_answer',
        v2ContentKind: 'model_history',
        v2Sequence: sequence,
      }),
      conversationId: historyPagingConversationId,
      threadId: 'history-paging-thread',
      turnId: `history-paging-turn-${sequence}`,
      updatedAt: new Date(Date.UTC(2026, 7, 15, 2, sequence)).toISOString(),
    };
  });
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

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

const planCustomAnswerText = '将 main 分支最新的代码合入当前分支后，再开始在正确的位置开发';
const planCustomAnswerSubmission: NativeQueuedSubmission = {
  id: 'plan-custom-answer-submission',
  conversationId: 'plan-custom-answer-conversation',
  content: planCustomAnswerText,
  status: 'paused',
  delivery: 'queue',
  position: 0,
  providerTurnId: null,
  clientUserMessageId: 'plan-custom-answer-client',
  pausedReason: 'recovery_required',
  error: {
    code: 'ZEUS_CODEX_RPC_TIMEOUT',
    message: 'Codex app-server request timed out: thread/turns/list',
    recoveryRequired: true,
  },
  createdAt: '2026-08-24T12:11:24.183Z',
  updatedAt: '2026-08-24T12:11:54.474Z',
};
const planCustomAnswerDurableItem: NativeSessionItemBuffer = {
  ...motionItem('plan-custom-answer-message', 'userMessage', 'completed', planCustomAnswerText, {
    role: 'user',
    delivery: 'queue',
    submissionId: planCustomAnswerSubmission.id,
    clientUserMessageId: planCustomAnswerSubmission.clientUserMessageId,
  }),
  key: 'plan-custom-answer:durable-message',
  conversationId: planCustomAnswerSubmission.conversationId,
  threadId: 'plan-custom-answer-thread',
  turnId: 'message:plan-custom-answer-message',
  localItemId: 'plan-custom-answer-message',
  clientUserMessageId: planCustomAnswerSubmission.clientUserMessageId,
  durableClientUserMessageId: planCustomAnswerSubmission.clientUserMessageId,
  timelineAt: planCustomAnswerSubmission.createdAt,
  updatedAt: planCustomAnswerSubmission.createdAt,
};

function planCustomAnswerProjectionState(): NativeSessionState {
  const base: NativeSessionState = {
    ...createInitialSessionState(),
    transportState: 'ready',
    conversationState: 'ready',
    projectId: 'project-zeus',
    conversationId: planCustomAnswerSubmission.conversationId,
    providerThreadId: 'plan-custom-answer-thread',
    snapshot: { id: planCustomAnswerSubmission.conversationId } as NonNullable<NativeSessionState['snapshot']>,
    items: { [planCustomAnswerDurableItem.key]: planCustomAnswerDurableItem },
    itemOrder: [planCustomAnswerDurableItem.key],
    transcriptRevision: 1,
  };
  const projected = sessionReducer(base, {
    type: 'queue_hydrated',
    queue: {
      state: { type: 'paused', reason: 'recovery_required' },
      waitReason: 'recovery_required',
      submissions: [planCustomAnswerSubmission],
    },
  });
  const staleDuplicate: NativeSessionItemBuffer = {
    ...planCustomAnswerDurableItem,
    key: 'plan-custom-answer:stale-queue-projection',
    itemId: 'queued-submission:plan-custom-answer-submission',
    localItemId: 'stale-plan-custom-answer-projection',
    status: 'paused',
    optimistic: true,
    payload: {
      ...planCustomAnswerDurableItem.payload,
      pausedReason: 'recovery_required',
    },
    updatedAt: planCustomAnswerSubmission.updatedAt,
  };
  return {
    ...projected,
    items: { ...projected.items, [staleDuplicate.key]: staleDuplicate },
    itemOrder: [...projected.itemOrder, staleDuplicate.key],
    // 这是截图里的无关附属读取错误；它不得借任一消息气泡显示。
    error: {
      code: 'ZEUS_CODEX_RPC_TIMEOUT',
      message: 'Codex app-server request timed out: account/read',
      recoveryRequired: true,
      retryable: false,
    },
    transcriptRevision: projected.transcriptRevision + 1,
  };
}

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
    pricingSourceUrls: {
      state: 'available',
      value: [
        'https://developers.openai.com/api/docs/pricing',
        'https://developers.openai.com/api/docs/guides/prompt-caching',
        'https://learn.chatgpt.com/docs/pricing#what-are-tokens-and-credits',
        'https://learn.chatgpt.com/docs/agent-configuration/speed',
      ],
    },
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

const unavailableRuntimeFact = { state: 'unavailable', reason: '视觉夹具：当前事实不可用。' } as const;
const unavailableRuntimeDetailsFixture: NativeRuntimeDetailsSnapshot = {
  model: unavailableRuntimeFact,
  effort: unavailableRuntimeFact,
  serviceTier: unavailableRuntimeFact,
  usage: {
    totalTokens: unavailableRuntimeFact,
    inputTokens: unavailableRuntimeFact,
    outputTokens: unavailableRuntimeFact,
    reasoningOutputTokens: unavailableRuntimeFact,
    contextTokens: unavailableRuntimeFact,
    contextWindow: unavailableRuntimeFact,
    cacheHitRate: unavailableRuntimeFact,
    apiEquivalentUsd: unavailableRuntimeFact,
    priceCoverage: unavailableRuntimeFact,
    pricingCatalogDate: unavailableRuntimeFact,
    pricingSourceUrls: unavailableRuntimeFact,
    historyComplete: unavailableRuntimeFact,
  },
  performance: {
    latestOutputTokensPerSecond: unavailableRuntimeFact,
    latestFirstVisibleResponseMs: unavailableRuntimeFact,
    cumulativeProcessedDurationMs: unavailableRuntimeFact,
  },
  activity: {
    turnCount: { state: 'available', value: 0 },
    modelRequestCount: { state: 'available', value: 0 },
    toolOrCommandCount: { state: 'available', value: 0 },
    retryCount: { state: 'available', value: 0 },
    failedTurnCount: { state: 'available', value: 0 },
  },
  changeSummary: unavailableRuntimeFact,
  environment: {
    cwd: unavailableRuntimeFact,
    branch: unavailableRuntimeFact,
    nativeSessionId: unavailableRuntimeFact,
    nativeSessionPath: unavailableRuntimeFact,
  },
};

const subagentListFixture: NativeSubagentListSnapshot = {
  conversationId: 'qa-subagent-parent',
  parentThreadId: 'qa-parent-thread',
  items: [
    {
      id: 'qa-subagent-completed',
      parentThreadId: 'qa-parent-thread',
      title: 'Zeno',
      nickname: 'Zeno',
      role: 'worker',
      path: '/root/zeno',
      preview: '已完成代码审查。',
      status: 'completed',
      createdAt: '2026-08-25T07:00:00.000Z',
      updatedAt: '2026-08-25T07:08:00.000Z',
    },
    {
      id: 'qa-subagent-running',
      parentThreadId: 'qa-parent-thread',
      title: 'Copernicus',
      nickname: 'Copernicus',
      role: 'reviewer',
      path: '/root/copernicus',
      preview: '正在审查内存上下文。',
      status: 'running',
      createdAt: '2026-08-25T07:10:00.000Z',
      updatedAt: '2026-08-25T07:18:00.000Z',
    },
  ],
};

function subagentItem(id: string, type: string, status: string, text: string, updatedAt: string, phase = 'prework'): NativeSubagentThreadSnapshot['turns'][number]['items'][number] {
  return {
    id,
    turnId: 'qa-subagent-turn',
    providerItemId: id,
    type,
    status,
    phase,
    text,
    payload: type === 'reasoning' ? { summary: [text] } : type === 'fileChange' ? { changes: [{ path: `apps/desktop/src/renderer/session/${id}.tsx`, kind: 'update' }] } : { phase },
    resources: [],
    startedAt: updatedAt,
    completedAt: status === 'completed' ? updatedAt : null,
    updatedAt,
  };
}

const completedSubagentThreadFixture: NativeSubagentThreadSnapshot = {
  conversationId: subagentListFixture.conversationId,
  parentThreadId: subagentListFixture.parentThreadId,
  agent: subagentListFixture.items[0]!,
  taskInstruction: {
    state: 'available',
    text: '只读审查 Renderer 会话投影：核对分页、水合与终态收敛；按严重程度输出问题，不修改文件。',
    source: 'collaboration_prompt',
    reason: null,
  },
  inheritedContext: {
    state: 'available',
    text: '# 代码审查任务\n\n审查当前任务分支的全部变化，并保留可复核的代码位置。',
    source: 'provider_thread_preview',
    reason: null,
  },
  historyBoundary: { state: 'confirmed', createdAt: '2026-08-25T07:00:00.000Z', ownedTurnCount: 1, hiddenInheritedTurnCount: 0, hiddenAmbiguousTurnCount: 0, reason: null },
  runtime: runtimeDetailsFixture,
  turns: [
    {
      id: 'qa-subagent-turn',
      status: 'completed',
      items: [
        subagentItem('summary-a', 'agentMessage', 'completed', 'A 摘要：先固定审查范围，再读取分页与水合实现。', '2026-08-25T07:00:05.000Z', 'commentary'),
        subagentItem('reasoning-1', 'reasoning', 'completed', 'Planning detailed read-only code review', '2026-08-25T07:00:10.000Z'),
        subagentItem('file-change-1', 'fileChange', 'completed', '', '2026-08-25T07:01:00.000Z'),
        subagentItem('summary-b', 'agentMessage', 'completed', 'B 摘要：分页边界已经确认，继续核对终态与历史恢复。', '2026-08-25T07:01:30.000Z', 'commentary'),
        subagentItem('reasoning-2', 'reasoning', 'completed', 'Executing file searches with patterns', '2026-08-25T07:02:00.000Z'),
        ...Array.from({ length: 4 }, (_, index) => subagentItem(`file-change-${index + 2}`, 'fileChange', 'completed', '', `2026-08-25T07:0${index + 2}:00.000Z`)),
        subagentItem('summary-c', 'agentMessage', 'completed', 'C 摘要：主要风险已经定位，最后整理证据与严重程度。', '2026-08-25T07:06:30.000Z', 'commentary'),
        ...Array.from({ length: 4 }, (_, index) => subagentItem(`file-change-${index + 6}`, 'fileChange', 'completed', '', `2026-08-25T07:0${index + 7}:00.000Z`)),
        subagentItem('answer', 'agentMessage', 'completed', '审查完成：已核对代码边界、失败语义与验证证据。', '2026-08-25T07:08:00.000Z', 'final_answer'),
      ],
    },
  ],
};

const runningSubagentThreadFixture: NativeSubagentThreadSnapshot = {
  ...completedSubagentThreadFixture,
  agent: subagentListFixture.items[1]!,
  taskInstruction: {
    state: 'unavailable',
    text: null,
    source: null,
    reason: '当前 Codex Provider 未在子线程读取协议中返回原始子任务指令；Zeus 不会用继承的主任务提示词冒充。',
  },
  historyBoundary: { ...completedSubagentThreadFixture.historyBoundary, createdAt: '2026-08-25T07:10:00.000Z' },
  turns: [
    {
      id: 'qa-subagent-turn',
      status: 'running',
      items: [
        subagentItem('running-reasoning-old', 'reasoning', 'completed', 'Preparing memory quick pass with citations', '2026-08-25T07:10:00.000Z'),
        subagentItem('running-file-change', 'fileChange', 'completed', '', '2026-08-25T07:12:00.000Z'),
        subagentItem('running-reasoning-current', 'reasoning', 'in_progress', 'Inspecting input size and context window', '2026-08-25T07:18:00.000Z'),
      ],
    },
  ],
};

const startingSessionState: NativeSessionState = {
  ...createInitialSessionState(),
  transportState: 'ready',
  conversationState: 'starting_turn',
  projectId: 'project-zeus',
  conversationId: 'motion-starting',
  providerThreadId: 'motion-starting-thread',
};

const failedStartingSessionState: NativeSessionState = {
  ...startingSessionState,
  conversationState: 'turn_failed',
  activeTurnId: null,
  startedTurnId: null,
  queue: { state: { type: 'idle' }, submissions: [] },
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

const archivedAssistantImageResource: ConversationResource = {
  ...defectImageResource,
  id: 'zeus-0323-archived-assistant-image',
  itemId: 'answer',
  presentation: 'inline',
  displayName: '持久化验收截图',
  attachmentRef: 'assistant-markdown-image.png',
  updatedAt: '2026-08-17T02:02:09.433Z',
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
const defectAnswerItem = defectItem('answer', 'agentMessage', '已修复。历史答复里的截图会归档并在重新打开会话后继续显示。\n\n![持久化验收截图](/private/tmp/zeus-archived-assistant-image.png)', 'final_answer', [
  archivedAssistantImageResource,
]);

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
  if (resource.id !== defectImageResource.id && resource.id !== archivedAssistantImageResource.id) throw new Error('非图片资源不提供图片预览。');
  return {
    kind: 'image',
    resource,
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
              <h3>当前摘要固定在底部</h3>
              <small>Provider 摘要无论原始到达位置如何，都只保留最新一条并显示在全部活动之后</small>
            </div>
            <button type="button" onClick={() => setFlowLatest((value) => !value)}>
              {flowLatest ? '恢复前一条摘要' : '模拟新的末尾摘要'}
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
  const previewRef = useRef<HTMLElement | null>(null);
  const stateRef = useRef(historyPagingSessionState);
  const inFlightRef = useRef(false);
  const failNextRequestRef = useRef(false);
  const statusVisibleRef = useRef(false);
  const [state, setState] = useState(historyPagingSessionState);
  const [transcriptKey, setTranscriptKey] = useState(0);
  const [reopenCount, setReopenCount] = useState(0);
  const [requestCount, setRequestCount] = useState(0);
  const [statusMountCount, setStatusMountCount] = useState(0);
  const [anchorDrift, setAnchorDrift] = useState<number | null>(null);
  const [eventLog, setEventLog] = useState('初次打开：尚未请求更早历史');
  stateRef.current = state;

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || typeof MutationObserver === 'undefined') return;
    const recordStatus = (): void => {
      const visible = Boolean(preview.querySelector('.session-v2-history-status'));
      if (visible && !statusVisibleRef.current) setStatusMountCount((count) => count + 1);
      statusVisibleRef.current = visible;
    };
    const observer = new MutationObserver(recordStatus);
    observer.observe(preview, { childList: true, subtree: true, attributes: true });
    recordStatus();
    return () => observer.disconnect();
  }, []);

  const resetScene = (mode: 'normal' | 'short' | 'failure'): void => {
    const itemOrder = mode === 'short' ? historyPagingSessionState.itemOrder.slice(-1) : historyPagingSessionState.itemOrder;
    const next = {
      ...historyPagingSessionState,
      itemOrder,
      transcriptRevision: historyPagingSessionState.transcriptRevision + transcriptKey + 1,
    };
    failNextRequestRef.current = mode === 'failure';
    inFlightRef.current = false;
    statusVisibleRef.current = false;
    setState(next);
    setTranscriptKey((key) => key + 1);
    setReopenCount(0);
    setRequestCount(0);
    setStatusMountCount(0);
    setAnchorDrift(null);
    setEventLog(mode === 'short' ? '短内容现场：请在消息区明确向上滚动' : mode === 'failure' ? '失败现场：向上滚动后才会发起失败请求' : '现场已重置：打开不会自动请求');
  };

  const reopenConversation = (): void => {
    setTranscriptKey((key) => key + 1);
    setReopenCount((count) => count + 1);
    setEventLog('会话已切回；请求计数应保持不变');
  };

  const readEarlierAtTop = (): void => {
    const container = previewRef.current?.querySelector<HTMLElement>('.session-transcript');
    if (!container) return;
    container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
    container.scrollTop = 0;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
  };

  const loadEarlierHistory = async (): Promise<void> => {
    const current = stateRef.current;
    const paging = current.snapshot?.v2Paging?.history;
    if (inFlightRef.current || !paging?.hasMore || !paging.nextCursor) return;
    const frozenCursor = paging.nextCursor;
    const container = previewRef.current?.querySelector<HTMLElement>('.session-transcript') ?? null;
    const anchorRow = container ? [...container.querySelectorAll<HTMLElement>('[data-transcript-row-key]')].find((row) => row.getBoundingClientRect().bottom > container.getBoundingClientRect().top) : undefined;
    const anchorKey = anchorRow?.dataset.transcriptRowKey ?? null;
    const anchorOffset = anchorRow && container ? anchorRow.getBoundingClientRect().top - container.getBoundingClientRect().top : null;
    inFlightRef.current = true;
    setRequestCount((count) => count + 1);
    setEventLog(`请求 ${frozenCursor}`);
    setState((value) => ({
      ...value,
      snapshot: value.snapshot
        ? {
            ...value.snapshot,
            v2Paging: value.snapshot.v2Paging ? { ...value.snapshot.v2Paging, history: { ...value.snapshot.v2Paging.history, loading: true, error: null } } : value.snapshot.v2Paging,
          }
        : value.snapshot,
    }));
    await new Promise((resolve) => setTimeout(resolve, 240));

    if (failNextRequestRef.current) {
      failNextRequestRef.current = false;
      inFlightRef.current = false;
      setState((value) => ({
        ...value,
        snapshot: value.snapshot
          ? {
              ...value.snapshot,
              v2Paging: value.snapshot.v2Paging ? { ...value.snapshot.v2Paging, history: { ...value.snapshot.v2Paging.history, loading: false, error: 'QA 模拟：更早历史读取失败' } } : value.snapshot.v2Paging,
            }
          : value.snapshot,
      }));
      setEventLog('分页失败：错误只应在本次用户触发后出现');
      throw new Error('QA 模拟：更早历史读取失败');
    }

    const page = frozenCursor === 'history-page-2' ? 2 : 3;
    // 第二页模拟仅含被 Renderer 折叠的工具配对：游标推进但没有可见高度变化，
    // 哨兵仍相交并连续读取第三页，用于核对提示不会逐页闪灭。
    const prepended = page === 2 ? [] : earlierHistoryPagingItems(page);
    const finalPage = page === 3;
    inFlightRef.current = false;
    setState((value) => {
      const nextItems = Object.fromEntries(prepended.map((item) => [item.key, item]));
      return {
        ...value,
        items: { ...nextItems, ...value.items },
        itemOrder: [...prepended.map((item) => item.key), ...value.itemOrder.filter((key) => !(key in nextItems))],
        transcriptRevision: value.transcriptRevision + 1,
        snapshot: value.snapshot
          ? {
              ...value.snapshot,
              v2Paging: value.snapshot.v2Paging
                ? {
                    ...value.snapshot.v2Paging,
                    history: {
                      ...value.snapshot.v2Paging.history,
                      nextCursor: finalPage ? null : 'history-page-3',
                      hasMore: !finalPage,
                      loading: false,
                      error: null,
                      oldestLoadedSequence: finalPage ? 41 : 45,
                    },
                  }
                : value.snapshot.v2Paging,
            }
          : value.snapshot,
      };
    });
    setEventLog(finalPage ? '连续分页完成：没有更多历史' : '第一页完成：哨兵仍在顶部，将连续读取下一页');
    await nextPaint();
    if (anchorKey && anchorOffset !== null && container) {
      const anchoredRow = [...container.querySelectorAll<HTMLElement>('[data-transcript-row-key]')].find((row) => row.dataset.transcriptRowKey === anchorKey);
      if (anchoredRow) setAnchorDrift(Math.abs(anchoredRow.getBoundingClientRect().top - container.getBoundingClientRect().top - anchorOffset));
    }
  };

  return (
    <section ref={previewRef} className="qa-motion-send-preview session-codex-parity-v1" data-testid="history-paging-preview">
      <div>
        <h3>向上读取历史消息</h3>
        <small>打开和切回只定位最新；真实向上阅读到顶部后才分页。</small>
      </div>
      <div className="qa-motion-fixture-actions">
        <button type="button" data-testid="history-read-earlier" onClick={readEarlierAtTop}>
          向上阅读到顶部
        </button>
        <button type="button" data-testid="history-reopen" onClick={reopenConversation}>
          切回会话
        </button>
        <button type="button" data-testid="history-reset" onClick={() => resetScene('normal')}>
          重置正常现场
        </button>
        <button type="button" data-testid="history-short" onClick={() => resetScene('short')}>
          短内容现场
        </button>
        <button type="button" data-testid="history-failure" onClick={() => resetScene('failure')}>
          分页失败现场
        </button>
      </div>
      <output data-testid="history-paging-counters">
        请求 {requestCount} 次 · 切回 {reopenCount} 次 · 提示挂载 {statusMountCount} 次 · 锚点漂移 {anchorDrift === null ? '待触发' : `${anchorDrift.toFixed(1)}px`}
      </output>
      <output data-testid="history-paging-events">{eventLog}</output>
      <output data-testid="history-range-evidence">
        同高水位 {historyPagingRangeEvidence.sameHighWater} · 新尾页重叠 {historyPagingRangeEvidence.overlappingTail} · 范围断开 {historyPagingRangeEvidence.disconnectedTail}
      </output>
      <div className="qa-send-transcript ai-workspace">
        <ConversationTranscript key={transcriptKey} state={state} language="zh-CN" onLoadEarlierHistory={loadEarlierHistory} />
      </div>
    </section>
  );
}

function CompleteMessagePreview() {
  const failNextRequestRef = useRef(false);
  const [controllerEpoch, setControllerEpoch] = useState(0);
  const [transcriptKey, setTranscriptKey] = useState(0);
  const [requestCount, setRequestCount] = useState(0);
  const controller = useMemo(
    () =>
      createSessionController({
        client: {
          async loadNativeConversationContentV2(_projectId, _conversationId, handle, options) {
            const offset = options?.offset ?? 0;
            if (handle !== completeMessageHandle || (offset !== 0 && offset !== completeMessagePageBoundary)) throw new Error('QA 完整正文分页身份错误。');
            setRequestCount((count) => count + 1);
            await new Promise((resolve) => setTimeout(resolve, 220));
            if (failNextRequestRef.current) {
              failNextRequestRef.current = false;
              throw new Error('QA 模拟：完整消息读取失败');
            }
            const nextOffset = offset === 0 ? completeMessagePageBoundary : null;
            return {
              schemaVersion: 2 as const,
              structureGeneration: '2026-08-21-conversation-snapshot-v2' as const,
              conversationId: completeMessageItem.conversationId,
              kind: 'model_content' as const,
              mimeType: 'text/plain; charset=utf-8',
              text: completeMessageCodePoints.slice(offset, nextOffset ?? undefined).join(''),
              offset,
              nextOffset,
              totalCharacters: completeMessageCodePoints.length,
              totalBytes: new TextEncoder().encode(completeMessageText).byteLength,
              contentByteLimit: 64 * 1024,
              redacted: false,
            };
          },
        } as unknown as SessionControllerClient,
        projectId: 'project-zeus',
        conversationId: completeMessageItem.conversationId,
        initialCachedState: completeMessageSessionState,
        storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      }),
    [controllerEpoch],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  useEffect(() => () => controller.dispose(), [controller]);

  const reset = (fail: boolean): void => {
    failNextRequestRef.current = fail;
    setControllerEpoch((epoch) => epoch + 1);
    setTranscriptKey((key) => key + 1);
    setRequestCount(0);
  };

  const complete = state.items[completeMessageItem.key]?.text.endsWith(completeMessageEndMarker) === true;
  return (
    <section className="qa-motion-send-preview session-codex-parity-v1" data-testid="complete-message-preview">
      <div>
        <h3>长消息完整正文</h3>
        <small>可见预览自动读取完整正文；失败时明确提示并允许重试。</small>
      </div>
      <div className="qa-motion-fixture-actions">
        <button type="button" data-testid="complete-message-reset" onClick={() => reset(false)}>
          重置自动补全
        </button>
        <button type="button" data-testid="complete-message-failure" onClick={() => reset(true)}>
          模拟补全失败
        </button>
        <button type="button" data-testid="complete-message-reopen" onClick={() => setTranscriptKey((key) => key + 1)}>
          切回已补全会话
        </button>
      </div>
      <output data-testid="complete-message-evidence">
        正文请求 {requestCount} 次 · 结尾标记 {complete ? '已显示' : '未显示'}
      </output>
      <div className="qa-send-transcript ai-workspace">
        <ConversationTranscript key={transcriptKey} state={state} language="zh-CN" onLoadV2Content={controller.loadV2Content} />
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
        <strong>单轮一个处理过程入口</strong>
        <small>运行中默认展开；A、B、C 只在同一个入口内部承接各自阶段过程。正文到达后自动收起，折叠态只留最终正文、交付文件与耗时。</small>
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

function BrowserNavigationFailurePreview() {
  if (!window.zeus?.getBrowserSnapshot || !window.zeus.openBrowserTab || !window.zeus.runBrowserCommand || !window.zeus.onBrowserEvent) return null;
  return (
    <section className="qa-motion-theme session-codex-parity-v1 theme-light" data-testid="browser-navigation-failure-preview">
      <header>
        <strong>内置浏览器页面级失败</strong>
        <small>输入无法连接的本机地址后，只保留 Chromium 失败页，不显示 Zeus 全局错误弹窗与遮罩。</small>
      </header>
      <div className="ai-workspace" style={{ blockSize: 620 }}>
        <BrowserWorkspace conversationId="qa-browser-navigation-failure" language="zh-CN" onClose={() => undefined} onToggleExpanded={() => undefined} onResetSize={() => undefined} onStageComments={() => undefined} />
      </div>
    </section>
  );
}

function InterruptedProcessPreview() {
  const [processLoadCount, setProcessLoadCount] = useState(0);
  return (
    <section className="qa-motion-theme session-codex-parity-v1 theme-light" data-testid="interrupted-process-preview">
      <header>
        <strong>重启后最后一轮中断过程</strong>
        <small>编排已收口为 interrupted，过程首次打开仍保持展开并自动读取详情；执行期摘要不再作为历史正文保留。</small>
      </header>
      <output data-testid="interrupted-process-load-count">处理过程读取 {processLoadCount} 次</output>
      <div className="qa-motion-transcript ai-workspace" data-testid="interrupted-process-transcript">
        <ConversationTranscript state={interruptedExecutionPhaseState} language="zh-CN" onLoadTurnProcess={() => setProcessLoadCount((count) => count + 1)} />
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
        <h3>运行期错误日志</h3>
        <small>业务位置只显示稳定的人话，技术错误经脱敏后写入本机运行日志，不再弹窗或遮挡应用。</small>
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
          记录普通错误
        </button>
        <button type="button" data-testid="fatal-error-dialog-trigger" onClick={() => reportApplicationError(new Error('Renderer crashed while rendering workspace.'), { language: 'zh-CN' })}>
          记录渲染错误
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

function CreationFailureExclusivityPreview() {
  return (
    <section className="qa-motion-send-preview session-codex-parity-v1" data-testid="creation-failure-exclusivity-preview">
      <div>
        <h3>创建失败与思考状态互斥</h3>
        <small>失败后只保留完整宽度错误与重试入口，不能继续显示“正在思考”。</small>
      </div>
      <div className="qa-creation-status-grid">
        <div className="qa-send-transcript ai-workspace" aria-label="桌面宽度最终失败态">
          <CreationFailureTranscript />
        </div>
        <div className="qa-send-transcript qa-creation-status-narrow ai-workspace" aria-label="窄容器最终失败态">
          <CreationFailureTranscript />
        </div>
      </div>
    </section>
  );
}

function CreationFailureTranscript() {
  return (
    <ConversationTranscript
      state={failedStartingSessionState}
      language="zh-CN"
      creationStatus={{
        state: 'failed',
        message: '连接失败',
        error: { code: 'ZEUS_CODEX_RPC_TIMEOUT', message: 'Codex app-server request timed out: account/read' },
        retryLabel: '重试',
        onRetry: () => undefined,
      }}
    />
  );
}

function CreationRetryProgressPreview() {
  return (
    <section className="qa-motion-send-preview session-codex-parity-v1" data-testid="creation-retry-progress-preview">
      <div>
        <h3>创建期自动重试进度</h3>
        <small>只显示当前次数和连接图标，不提前暴露完整错误或手动按钮。</small>
      </div>
      <div className="qa-send-transcript qa-creation-status-narrow ai-workspace">
        <ConversationTranscript state={failedStartingSessionState} language="zh-CN" creationStatus={{ state: 'retrying', message: '正在重试', retryAttempt: 3, maxRetries: 5 }} />
      </div>
    </section>
  );
}

function PlanCustomAnswerProjectionPreview() {
  return (
    <section className="qa-motion-send-preview session-codex-parity-v1" data-testid="plan-custom-answer-projection-preview">
      <div>
        <h3>PLAN 自定义回答单一投影</h3>
        <small>本地消息、暂停队列和迟到投影共享同一 submission；无关的附属读取错误不挂到消息下。</small>
      </div>
      <div className="qa-send-transcript ai-workspace">
        <ConversationTranscript state={planCustomAnswerProjectionState()} language="zh-CN" />
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
      <BrowserNavigationFailurePreview />
      <InterruptedProcessPreview />
      <SendScrollPreview />
      <DeliveryFailurePreview />
      <CreationRetryProgressPreview />
      <CreationFailureExclusivityPreview />
      <PlanCustomAnswerProjectionPreview />
      <HistoryPagingPreview />
      <CompleteMessagePreview />
      <LongScrollPreview />
      <NoRefillPreview />
      <ErrorContractPreview />
      <SteeringPreview />
      <ConversationSelectionRecoveryPreview />
      <StopButtonPreview />
      <section className="qa-motion-theme session-codex-parity-v1 theme-light" data-testid="runtime-details-horizontal">
        <h2>运行详情分区数据表</h2>
        <RuntimeDetails runtime={runtimeDetailsFixture} language="zh-CN" scope="session" />
      </section>
      <section className="qa-motion-theme session-codex-parity-v1 theme-light" data-testid="runtime-details-unavailable">
        <h2>Subagent 运行详情空值</h2>
        <RuntimeDetails runtime={unavailableRuntimeDetailsFixture} language="zh-CN" scope="subagent" />
      </section>
      <SubagentTranscriptPreview />
      <ApplicationErrorDialogHost language="zh-CN" />
    </main>
  );
}

function TimeoutRetryQaApp() {
  return (
    <main className="macos-ai-app zeus-shell qa-page qa-motion-page" data-testid="timeout-retry-qa">
      <header className="qa-heading">
        <p>ZEUS-0364 · 真实 DOM 错误栏验收</p>
        <h1>Codex RPC timeout 自动重试</h1>
      </header>
      <CreationRetryProgressPreview />
      <CreationFailureExclusivityPreview />
    </main>
  );
}

function CompleteMessageQaApp() {
  return (
    <main className="macos-ai-app zeus-shell qa-page qa-motion-page" data-testid="complete-message-qa">
      <header className="qa-heading">
        <p>ZEUS-0376 · 真实 DOM 长消息验收</p>
        <h1>长消息完整正文</h1>
      </header>
      <CompleteMessagePreview />
    </main>
  );
}

function SubagentTranscriptPreview() {
  const [fullWidth, setFullWidth] = useState(false);
  return (
    <section className="qa-motion-theme session-codex-parity-v1 theme-light" data-testid="subagent-transcript-parity">
      <h2>Subagent 与普通会话同源转录</h2>
      <div className="session-workspace-root" style={{ blockSize: 720, border: '1px solid var(--session-line)' }}>
        <SubagentWorkspace
          language="zh-CN"
          conversationId={subagentListFixture.conversationId}
          activityRevision="qa-subagent"
          hintCount={subagentListFixture.items.length}
          initialSnapshot={subagentListFixture}
          fullWidth={fullWidth}
          onFullWidthChange={setFullWidth}
          onClose={() => undefined}
          loadList={async () => subagentListFixture}
          loadThread={async (threadId) => (threadId === runningSubagentThreadFixture.agent.id ? runningSubagentThreadFixture : completedSubagentThreadFixture)}
        />
      </div>
    </section>
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
          <ConversationMarkdown text={inlineResourceMarkdown} streamId="qa:inline-resources" phase="final" language="zh-CN" resources={inlineResourceItems} onOpenResource={ignoreResourceOpen} />
        </div>
      </section>
    </main>
  );
}

const markdownSourcePreview: ConversationResourcePreview = {
  kind: 'source',
  resource: {
    id: 'resource-markdown-preview',
    projectId: 'project-zeus',
    conversationId: 'conversation-markdown-preview',
    turnId: 'turn-markdown-preview',
    itemId: 'item-markdown-preview',
    kind: 'file',
    presentation: 'inline',
    displayName: 'TASK_20260825_007_会话Markdown文件默认预览.md',
    projectRelativePath: 'docs/TASK_20260825_007_会话Markdown文件默认预览.md',
    iconKind: 'markdown',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  },
  language: 'markdown',
  content: '# Markdown 默认预览\n\n从会话正文点击 Markdown 文件后，应直接看到渲染后的正文。\n\n## 验收点\n\n- 首次打开显示预览\n- 可以切换到源码\n- 再次打开恢复预览\n\n```ts\nconst mode = "preview";\n```',
  lineCount: 13,
  truncated: false,
};

const typescriptSourcePreview: ConversationResourcePreview = {
  kind: 'source',
  resource: {
    id: 'resource-typescript-preview',
    projectId: 'project-zeus',
    conversationId: 'conversation-markdown-preview',
    turnId: 'turn-markdown-preview',
    itemId: 'item-typescript-preview',
    kind: 'file',
    presentation: 'inline',
    displayName: 'SourceWorkspace.tsx',
    projectRelativePath: 'apps/desktop/src/renderer/session/SourceWorkspace.tsx',
    iconKind: 'typescript',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  },
  language: 'typescript',
  content: 'export const defaultView = "source";\n',
  lineCount: 1,
  truncated: false,
};

function SourcePreviewQaApp() {
  const [preview, setPreview] = useState<ConversationResourcePreview>(markdownSourcePreview);
  const [viewMode, setViewMode] = useState(() => defaultSourceWorkspaceViewMode(markdownSourcePreview));
  const [fullWidth, setFullWidth] = useState(false);

  function openPreview(nextPreview: ConversationResourcePreview): void {
    setPreview(nextPreview);
    setViewMode(defaultSourceWorkspaceViewMode(nextPreview));
  }

  return (
    <main className="macos-ai-app zeus-shell session-codex-parity-v1 qa-page qa-source-preview-page" data-theme="light" data-testid="source-preview-fixture">
      <header>
        <div>
          <p>2026-08-25 · 真实组件交互验收</p>
          <h1>会话 Markdown 文件默认预览</h1>
        </div>
        <nav className="qa-source-preview-actions" aria-label="资源打开入口">
          <button type="button" onClick={() => openPreview(markdownSourcePreview)}>
            打开 Markdown
          </button>
          <button type="button" onClick={() => openPreview(typescriptSourcePreview)}>
            打开 TypeScript
          </button>
        </nav>
      </header>
      <div className="qa-source-preview-workspace">
        <SourceWorkspace preview={preview} viewMode={viewMode} onViewModeChange={setViewMode} language="zh-CN" fullWidth={fullWidth} onFullWidthChange={setFullWidth} onClose={() => undefined} />
      </div>
    </main>
  );
}

const taskPushQaTask: TaskRecord = {
  id: 'task-zeus-0338',
  projectId: 'project-zeus',
  taskCode: 'ZEUS-0338',
  title: '会话的输出方式',
  taskType: 'optimization',
  description: '',
  optimizationCurrentState: '推送弹窗不能被无关的账户读取阻塞。',
  optimizationExpectedOutcome: 'Git 与 Worktree 读取独立收敛。',
  status: 'ready',
  tags: [],
};

const taskPushQaCapabilities: CodexTaskPushCapabilities = {
  generationId: 'provider-account-not-read',
  initializedAt: '2026-08-24T12:35:00.000Z',
  projectId: taskPushQaTask.projectId,
  taskId: taskPushQaTask.id,
  canonicalPrompt: 'ZEUS-0338 会话的输出方式',
  taskContextRevision: 'task-context-revision',
  parentContextRevision: 'task-context-revision',
  repositoryRevision: 'repository-revision',
  currentAttachmentOptions: [],
  currentConversationOptions: [],
  parentContextOptions: [],
  relatedContextOptions: [],
  preferredModel: 'connection-deepseek-v4-flash',
  models: [
    {
      id: 'connection-deepseek-v4-flash',
      model: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      agentKind: 'pi',
      sourceId: 'deepseek',
      sourceName: 'DeepSeek',
      available: true,
      supportedReasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
      serviceTiers: [],
    },
  ],
  codexAccount: {
    generationId: 'codex-unavailable',
    requiresOpenaiAuth: false,
    signedIn: false,
    accountType: null,
    planType: null,
  },
  repositories: [
    {
      id: 'repository-zeus',
      projectId: taskPushQaTask.projectId,
      name: 'zeus',
      relativePath: '.',
      localPath: '/Users/david/hypha/zeus',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
      branch: 'main',
      headSha: '79cfd91',
      clean: false,
      defaultRemoteName: 'origin',
      remoteRefreshStatus: 'not_requested',
      remoteRefreshError: null,
      sourceRefs: [
        {
          ref: 'refs/heads/main',
          label: 'main',
          kind: 'local',
          group: 'local',
          current: true,
        },
      ],
      suggestedBranchName: 'zeus/ZEUS-0338-01',
    },
  ],
  directWorkspace: {
    path: '/Users/david/hypha/zeus',
    activeWritableConversationCount: 0,
  },
  existingEnvironments: [],
  sharedWritablePaths: [],
  git: {
    primaryWorkspacePath: '/Users/david/hypha/zeus',
    primaryBranch: 'main',
    primaryHeadSha: '79cfd91',
    primaryClean: false,
    defaultRemoteName: 'origin',
    sourceRefs: [
      {
        ref: 'refs/heads/main',
        label: 'main',
        kind: 'local',
        group: 'local',
        current: true,
      },
    ],
    suggestedBranchName: 'zeus/ZEUS-0338-01',
    worktreeRoot: '/Users/david/hypha/.zeus-worktrees',
  },
};

const taskPushQaForm: TaskModelPushForm = {
  model: 'connection-deepseek-v4-flash',
  effort: 'high',
  serviceTier: { type: 'standard' },
  serviceTierDowngraded: false,
  workMode: 'default',
  permissionMode: 'auto',
  workspaceMode: 'worktree',
  taskBranchMode: 'create',
  environmentId: '',
  directConcurrencyConfirmed: false,
  repositorySelections: {
    'repository-zeus': {
      sourceRef: 'refs/heads/main',
      branchName: 'zeus/ZEUS-0338-01',
      includeLocalChanges: false,
    },
  },
  currentConversationIds: [],
  parentContextSelections: {},
  relatedContextSelections: {},
  supplementalInfo: '',
  supplementalAttachments: [],
};

function TaskPushDecouplingApp() {
  const startReady = new URLSearchParams(window.location.search).has('ready');
  const [capabilities, setCapabilities] = useState<CodexTaskPushCapabilities | null>(() => (startReady ? taskPushQaCapabilities : null));
  const [status, setStatus] = useState<TaskModelPushModalStatus>(() => (startReady ? 'ready' : 'loading'));
  const [form, setForm] = useState<TaskModelPushForm>(taskPushQaForm);

  useEffect(() => {
    document.body.dataset.taskPushSubmitted = 'false';
    if (startReady) return;
    const timer = window.setTimeout(() => {
      setCapabilities(taskPushQaCapabilities);
      setStatus('ready');
    }, 2_500);
    return () => window.clearTimeout(timer);
  }, [startReady]);

  return (
    <main className="macos-ai-app zeus-shell qa-page" data-testid="task-push-decoupling-fixture">
      <p>账户 RPC 保持未完成时，Git 与 Worktree 表单仍必须独立完成加载。</p>
      <TaskModelPushModal
        open
        language="zh-CN"
        task={taskPushQaTask}
        projectName="Zeus"
        capabilities={capabilities}
        runtimeCapabilities={null}
        form={form}
        status={status}
        configImportPreview={null}
        configImportNeedsActivation={false}
        refreshingRepositoryId={null}
        error={null}
        onChange={setForm}
        onRefreshRepository={() => undefined}
        onClose={() => undefined}
        onCancelAuthentication={() => undefined}
        onCancelCodexConfigImport={() => undefined}
        onImportCodexConfig={() => undefined}
        onSkipCodexConfigImport={() => undefined}
        onSubmit={(event) => {
          event.preventDefault();
          document.body.dataset.taskPushSubmitted = 'true';
        }}
      />
    </main>
  );
}

type MarkdownQaScenario = '20kb' | '100kb';

interface MarkdownQaResult {
  scenario: MarkdownQaScenario;
  firstVisibleMs: number;
  settleMs: number;
  maxLongTaskMs: number;
  frameP95Ms: number;
  inputCommitMs: number;
  stableFirstNode: boolean;
  placeholderCount: number;
  unauthorizedRequests: number;
  unsafeClickableLinks: number;
  codeCopyAvailable: boolean;
  transcriptCopyMatches: boolean;
  sourceMatches: boolean;
  selectionOperable: boolean;
  scrollOperable: boolean;
  passed: boolean;
}

interface MarkdownQaRun {
  scenario: MarkdownQaScenario;
  fixture: string;
  startedAt: number;
  finalAt: number;
  firstVisibleAt: number | null;
  firstNode: Element | null;
  frameGaps: number[];
  maxLongTaskMs: number;
  inputRequestedAt: number | null;
  inputCommitMs: number;
  finished: boolean;
}

const unauthorizedMarkdownUrl = 'https://unauthorized.invalid/zeus-0367.png';
const markdownQaResources: ConversationResource[] = [
  {
    id: 'qa-markdown-authorized-link',
    projectId: 'project-zeus',
    conversationId: 'conversation-markdown-qa',
    turnId: 'turn-markdown-qa',
    itemId: 'item-markdown-qa',
    kind: 'website',
    presentation: 'inline',
    displayName: 'Zeus 已审计资源',
    url: 'https://docs.zeus.local/authorized',
    domain: 'docs.zeus.local',
    local: true,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  },
  {
    id: 'qa-markdown-authorized-image',
    projectId: 'project-zeus',
    conversationId: 'conversation-markdown-qa',
    turnId: 'turn-markdown-qa',
    itemId: 'item-markdown-qa',
    kind: 'attachment',
    presentation: 'inline',
    displayName: '权威会话图片',
    attachmentRef: 'qa-authorized-image',
    mimeType: 'image/png',
    previewKind: 'image',
    iconKind: 'image',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  },
];

const markdownFixture20kb = buildMarkdownQaFixture(20_000);
const markdownFixture100kb = buildMarkdownQaFixture(100_000);

function buildMarkdownQaFixture(targetLength: number): string {
  const featureBlock = [
    '# ZEUS-0367 增量渲染现场',
    '',
    '首段正文需要在首个输入后快速可见。Incremental rendering keeps stable prefixes mounted。',
    '',
    '- 第一层列表',
    '  - 第二层列表包含 **中文** 与 _English_',
    '    1. 有序子项 `streamId`',
    '    2. 最终原位收口',
    '',
    '| 场景 | 输入 | 预期 |',
    '| :--- | ---: | :--- |',
    '| 连续流 | 20 字符 / 30Hz | 稳定节点复用 |',
    '| 突发恢复 | 100KB | 分批挂载 |',
    '',
    '```ts',
    'const phase: "streaming" | "final" = "streaming";',
    'const safe = resources.some((resource) => resource.id === target);',
    '```',
    '',
    '[页内锚点](#qa-markdown-stream-end) · [Zeus 已审计资源](https://docs.zeus.local/authorized) · [未授权链接](https://unauthorized.invalid/blocked)',
    '',
    '![权威会话图片](attachment://qa-authorized-image)',
    '',
    `![未授权图片](${unauthorizedMarkdownUrl})`,
    '',
    '<img src="https://unauthorized.invalid/raw-html.png" onerror="alert(1)">',
    '',
  ].join('\n');
  const tail = '\n\n<span id="qa-markdown-stream-end"></span>\n\n[未闭合链接](https://unauthorized.invalid/incomplete';
  const filler = '稳定段落用于验证追加解析与节点复用。The renderer keeps interaction responsive while the cumulative Markdown buffer grows, and it must not replay complete content at a fixed typewriter speed. 0123456789 '.repeat(5).trim();
  let value = featureBlock;
  let index = 1;
  while (value.length + filler.length + tail.length + 16 < targetLength) {
    value += `\n\n${index}. ${filler}`;
    index += 1;
  }
  const remaining = targetLength - value.length - tail.length;
  if (remaining > 0) value += `\n\n${'中'.repeat(Math.max(0, remaining - 2))}`;
  return `${value}${tail}`.slice(0, targetLength);
}

function MarkdownStreamingQaApp() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef('');
  const runRef = useRef<MarkdownQaRun | null>(null);
  const cleanupRef = useRef<() => void>(() => undefined);
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<'streaming' | 'final'>('streaming');
  const [streamId, setStreamId] = useState('markdown-qa:idle');
  const [scenario, setScenario] = useState<MarkdownQaScenario | 'idle'>('idle');
  const [probeValue, setProbeValue] = useState('');
  const [openedResources, setOpenedResources] = useState(0);
  const [result, setResult] = useState<MarkdownQaResult | null>(null);
  textRef.current = text;

  useLayoutEffect(() => {
    const run = runRef.current;
    if (run?.inputRequestedAt !== null && run?.inputRequestedAt !== undefined && probeValue) {
      run.inputCommitMs = performance.now() - run.inputRequestedAt;
      run.inputRequestedAt = null;
    }
  }, [probeValue]);

  useEffect(() => () => cleanupRef.current(), []);

  const finishRun = useCallback(async () => {
    const run = runRef.current;
    const root = rootRef.current;
    const stage = stageRef.current;
    if (!run || !root || run.finished || !run.finalAt) return;
    run.finished = true;
    const currentFirstNode = root.querySelector('.node-slot');
    const placeholderCount = root.querySelectorAll('.node-placeholder').length;
    const frameP95Ms = percentile(run.frameGaps, 0.95);
    const unauthorizedRequests = performance.getEntriesByType('resource').filter((entry) => entry.name.startsWith('https://unauthorized.invalid/')).length;
    const unsafeClickableLinks = root.querySelectorAll('a[href*="unauthorized.invalid"]').length;
    const codeCopyAvailable = Boolean(root.querySelector('.session-code-block .session-copy-button'));
    let copiedTranscript = '';
    const transcriptCopySucceeded = await copyTranscriptText(run.fixture, {
      writeNative: async (value) => {
        copiedTranscript = value;
        return { written: true };
      },
    });
    const transcriptCopyMatches = transcriptCopySucceeded && copiedTranscript === run.fixture;
    const textRoot = root.querySelector('.text-node');
    const textWalker = textRoot ? document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT) : null;
    let textNode = textWalker?.nextNode() ?? null;
    while (textNode && !textNode.textContent?.trim()) textNode = textWalker?.nextNode() ?? null;
    let selectionOperable = false;
    if (textNode?.nodeType === Node.TEXT_NODE && textNode.textContent) {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(1, textNode.textContent.length));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      selectionOperable = Boolean(selection?.toString());
      selection?.removeAllRanges();
    }
    let scrollOperable = false;
    if (stage) {
      stage.scrollTop = Math.max(1, stage.scrollHeight - stage.clientHeight);
      scrollOperable = stage.scrollTop > 0;
    }
    const firstVisibleMs = run.firstVisibleAt === null ? Number.POSITIVE_INFINITY : run.firstVisibleAt - run.startedAt;
    const settleMs = performance.now() - run.finalAt;
    const stableFirstNode = Boolean(run.firstNode && currentFirstNode === run.firstNode);
    const commonPassed =
      stableFirstNode && placeholderCount === 0 && unauthorizedRequests === 0 && unsafeClickableLinks === 0 && codeCopyAvailable && transcriptCopyMatches && textRef.current === run.fixture && selectionOperable && scrollOperable;
    const passed = commonPassed && (run.scenario === '20kb' ? firstVisibleMs <= 100 && settleMs <= 150 && run.maxLongTaskMs < 50 && frameP95Ms <= 32 : settleMs <= 2_000 && run.maxLongTaskMs < 100 && run.inputCommitMs <= 100);
    setResult({
      scenario: run.scenario,
      firstVisibleMs,
      settleMs,
      maxLongTaskMs: run.maxLongTaskMs,
      frameP95Ms,
      inputCommitMs: run.inputCommitMs,
      stableFirstNode,
      placeholderCount,
      unauthorizedRequests,
      unsafeClickableLinks,
      codeCopyAvailable,
      transcriptCopyMatches,
      sourceMatches: textRef.current === run.fixture,
      selectionOperable,
      scrollOperable,
      passed,
    });
    setScenario('idle');
    cleanupRef.current();
  }, []);

  const startScenario = useCallback((nextScenario: MarkdownQaScenario) => {
    cleanupRef.current();
    performance.clearResourceTimings();
    const fixture = nextScenario === '20kb' ? markdownFixture20kb : markdownFixture100kb;
    const nextStreamId = `markdown-qa:${nextScenario}:${Date.now()}`;
    setResult(null);
    setProbeValue('');
    setText('');
    setPhase('streaming');
    setStreamId(nextStreamId);
    setScenario(nextScenario);

    let interval = 0;
    let animationFrame = 0;
    let probeTimer = 0;
    let mutationObserver: MutationObserver | null = null;
    let longTaskObserver: PerformanceObserver | null = null;
    let cancelled = false;

    animationFrame = requestAnimationFrame(() => {
      if (cancelled) return;
      const startedAt = performance.now();
      const run: MarkdownQaRun = {
        scenario: nextScenario,
        fixture,
        startedAt,
        finalAt: 0,
        firstVisibleAt: null,
        firstNode: null,
        frameGaps: [],
        maxLongTaskMs: 0,
        inputRequestedAt: null,
        inputCommitMs: 0,
        finished: false,
      };
      runRef.current = run;

      mutationObserver = new MutationObserver(() => {
        const root = rootRef.current;
        const firstNode = root?.querySelector('.node-slot') ?? null;
        if (!run.firstNode && firstNode) run.firstNode = firstNode;
        if (run.firstVisibleAt === null && root?.textContent?.trim()) run.firstVisibleAt = performance.now();
      });
      if (rootRef.current) mutationObserver.observe(rootRef.current, { childList: true, characterData: true, subtree: true });

      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) run.maxLongTaskMs = Math.max(run.maxLongTaskMs, entry.duration);
        });
        longTaskObserver.observe({ type: 'longtask', buffered: false });
      } catch {
        longTaskObserver = null;
      }

      let previousFrame = startedAt;
      const sampleFrame = (now: number) => {
        run.frameGaps.push(now - previousFrame);
        previousFrame = now;
        if (!run.finished && !cancelled) animationFrame = requestAnimationFrame(sampleFrame);
      };
      animationFrame = requestAnimationFrame(sampleFrame);

      probeTimer = window.setTimeout(() => {
        run.inputRequestedAt = performance.now();
        setProbeValue(`输入响应-${nextScenario}`);
      }, 50);

      if (nextScenario === '20kb') {
        let cursor = 0;
        const pushChunk = () => {
          cursor = Math.min(fixture.length, cursor + 20);
          setText(fixture.slice(0, cursor));
          if (cursor < fixture.length) return;
          window.clearInterval(interval);
          run.finalAt = performance.now();
          setPhase('final');
        };
        pushChunk();
        interval = window.setInterval(pushChunk, 1_000 / 30);
      } else {
        animationFrame = requestAnimationFrame(() => {
          run.finalAt = performance.now();
          setText(fixture);
          setPhase('final');
        });
      }
    });

    cleanupRef.current = () => {
      cancelled = true;
      if (interval) window.clearInterval(interval);
      if (animationFrame) cancelAnimationFrame(animationFrame);
      if (probeTimer) window.clearTimeout(probeTimer);
      mutationObserver?.disconnect();
      longTaskObserver?.disconnect();
    };
  }, []);

  return (
    <main className="macos-ai-app zeus-shell session-codex-parity-v1 qa-page qa-markdown-stream-page" data-theme="light" data-testid="markdown-stream-fixture">
      <header className="qa-heading">
        <p>ZEUS-0367 · 确定性会话 Markdown 现场</p>
        <h1>增量与流式渲染</h1>
      </header>
      <section className="qa-markdown-stream-controls">
        <button type="button" disabled={scenario !== 'idle'} onClick={() => startScenario('20kb')}>
          运行 20KB · 20 字符 / 30Hz
        </button>
        <button type="button" disabled={scenario !== 'idle'} onClick={() => startScenario('100kb')}>
          运行 100KB 突发恢复
        </button>
        <label>
          输入响应探针
          <input value={probeValue} onChange={(event) => setProbeValue(event.currentTarget.value)} placeholder="运行期间仍可输入" />
        </label>
        <span role="status" data-testid="markdown-stream-status">
          {scenario === 'idle' ? '就绪' : scenario === '20kb' ? `${text.length} / ${markdownFixture20kb.length}` : `${text.length} / ${markdownFixture100kb.length}`}
        </span>
      </section>
      <section className="qa-markdown-stream-grid">
        <div ref={stageRef} className="qa-markdown-stream-stage" data-testid="markdown-stream-stage">
          <div ref={rootRef}>
            <ConversationMarkdown
              text={text}
              streamId={streamId}
              phase={phase}
              language="zh-CN"
              resources={markdownQaResources}
              onOpenResource={() => setOpenedResources((current) => current + 1)}
              onLoadResourcePreview={async (resource) => ({
                kind: 'image',
                resource: resource as Extract<ConversationResource, { kind: 'attachment' }>,
                mimeType: 'image/png',
                dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                byteLength: 68,
              })}
              onRenderSettled={finishRun}
            />
          </div>
        </div>
        <aside className="qa-markdown-stream-results" data-testid="markdown-stream-results" data-pass={result?.passed ?? undefined}>
          <h2>现场指标</h2>
          {result ? (
            <dl>
              <dt>场景</dt>
              <dd>{result.scenario}</dd>
              <dt>首段可见</dt>
              <dd data-testid="markdown-first-visible-ms">{formatQaMetric(result.firstVisibleMs)} ms</dd>
              <dt>final 收口</dt>
              <dd data-testid="markdown-settle-ms">{formatQaMetric(result.settleMs)} ms</dd>
              <dt>最大长任务</dt>
              <dd>{formatQaMetric(result.maxLongTaskMs)} ms</dd>
              <dt>帧间隔 P95</dt>
              <dd>{formatQaMetric(result.frameP95Ms)} ms</dd>
              <dt>输入提交</dt>
              <dd>{formatQaMetric(result.inputCommitMs)} ms</dd>
              <dt>首节点身份</dt>
              <dd>{result.stableFirstNode ? '保持' : '变化'}</dd>
              <dt>占位节点</dt>
              <dd data-testid="markdown-placeholder-count">{result.placeholderCount}</dd>
              <dt>未授权请求</dt>
              <dd data-testid="markdown-unauthorized-requests">{result.unauthorizedRequests}</dd>
              <dt>未授权可点击链接</dt>
              <dd>{result.unsafeClickableLinks}</dd>
              <dt>代码复制按钮</dt>
              <dd>{result.codeCopyAvailable ? '可用' : '缺失'}</dd>
              <dt>正文复制</dt>
              <dd>{result.transcriptCopyMatches ? '与累计正文一致' : '不一致'}</dd>
              <dt>累计正文</dt>
              <dd>{result.sourceMatches ? '一致' : '不一致'}</dd>
              <dt>选择 / 滚动</dt>
              <dd>
                {result.selectionOperable ? '可选择' : '选择失败'} / {result.scrollOperable ? '可滚动' : '滚动失败'}
              </dd>
            </dl>
          ) : (
            <p>运行场景后显示确定性指标。</p>
          )}
          <small>已打开资源：{openedResources}</small>
        </aside>
      </section>
    </main>
  );
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function formatQaMetric(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '∞';
}

const motionQa = new URLSearchParams(window.location.search).has('motion');
const defectQa = new URLSearchParams(window.location.search).has('zeus0323');
const taskPushQa = new URLSearchParams(window.location.search).has('task-push');
const sourcePreviewQa = new URLSearchParams(window.location.search).has('source-preview');
const markdownStreamQa = new URLSearchParams(window.location.search).has('markdown-stream');
const timeoutRetryQa = new URLSearchParams(window.location.search).has('timeout-retry');
const completeMessageQa = new URLSearchParams(window.location.search).has('complete-message');
// 开发态热更新复用同一根节点，避免视觉验收页重复挂载并制造无关控制台错误。
const qaRoot = window.__zeusSessionStylesRoot ?? createRoot(document.getElementById('root')!);
window.__zeusSessionStylesRoot = qaRoot;
qaRoot.render(
  markdownStreamQa ? (
    <MarkdownStreamingQaApp />
  ) : sourcePreviewQa ? (
    <SourcePreviewQaApp />
  ) : taskPushQa ? (
    <TaskPushDecouplingApp />
  ) : defectQa ? (
    <ConversationDefectApp />
  ) : timeoutRetryQa ? (
    <TimeoutRetryQaApp />
  ) : completeMessageQa ? (
    <CompleteMessageQaApp />
  ) : motionQa ? (
    <MotionApp />
  ) : (
    <App />
  ),
);
