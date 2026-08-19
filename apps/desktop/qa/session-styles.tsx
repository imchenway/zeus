import React, { useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { GlobeSimpleIcon as GlobeSimple } from '@phosphor-icons/react/dist/csr/GlobeSimple';
import '../src/renderer/styles.css';
import '../src/renderer/session/session.css';
import './session-styles.css';
import type { ConversationResource } from '@zeus/shared';
import { PendingRequestSurface } from '../src/renderer/session/PendingRequestSurface.js';
import { type ConversationTreeRuntimeState, type ProjectConversationGroup, ProjectConversationTree } from '../src/renderer/session/ProjectConversationTree.js';
import type { NativeConversationChoice, NativePendingRequest, NativeSessionItemBuffer, NativeSessionState } from '../src/renderer/session/sessionTypes.js';
import { SafeMarkdown, ThreadItemView } from '../src/renderer/session/ThreadItemView.js';
import { ConversationTranscript } from '../src/renderer/session/ConversationTranscript.js';
import { PlanSummary } from '../src/renderer/session/PlanSummary.js';
import { createInitialSessionState } from '../src/renderer/session/sessionReducer.js';

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

interface MotionDiagnosticsSnapshot {
  viewport: string;
  reducedMotion: string;
  focusAnimations: string;
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
    const reasoningIcon = transcript?.querySelector<HTMLElement>('.session-reasoning-summary-icon') ?? null;
    const activityIcon = transcript?.querySelector<HTMLElement>('.session-activity-item-icon') ?? null;
    const focusAnimationNames = [tailStyle?.animationName, reasoningIcon ? window.getComputedStyle(reasoningIcon).animationName : null, activityIcon ? window.getComputedStyle(activityIcon).animationName : null].filter(
      (name): name is string => Boolean(name && name !== 'none'),
    );
    setSnapshot({
      viewport: `${window.innerWidth}×${window.innerHeight}`,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? '开启' : '关闭',
      focusAnimations: `${focusAnimationNames.length}（${focusAnimationNames.join('、') || '无'}）`,
      tailAnchor: tailAnchor?.tagName.toLocaleLowerCase() ?? '未找到',
      tailSize: tailStyle ? `${tailStyle.inlineSize} × ${tailStyle.blockSize}` : '未找到',
      tailAnimation: tailStyle?.animationName ?? '未找到',
      reasoningAnimation: reasoningIcon ? window.getComputedStyle(reasoningIcon).animationName : '未找到',
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
    </main>
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
// 开发态热更新复用同一根节点，避免视觉验收页重复挂载并制造无关控制台错误。
const qaRoot = window.__zeusSessionStylesRoot ?? createRoot(document.getElementById('root')!);
window.__zeusSessionStylesRoot = qaRoot;
qaRoot.render(motionQa ? <MotionApp /> : <App />);
