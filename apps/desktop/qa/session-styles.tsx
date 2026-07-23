import React from 'react';
import {createRoot} from 'react-dom/client';
import '../src/renderer/styles.css';
import '../src/renderer/session/session.css';
import './session-styles.css';
import {PendingRequestSurface} from '../src/renderer/session/PendingRequestSurface.js';
import {
    type ConversationTreeRuntimeState,
    type ProjectConversationGroup,
    ProjectConversationTree
} from '../src/renderer/session/ProjectConversationTree.js';
import type {NativeConversationChoice, NativePendingRequest} from '../src/renderer/session/sessionTypes.js';

const referenceBase = 'http://127.0.0.1:4181';

function conversation(id: string, taskId: string, updatedAt: string, hasUnreadCompletion = false): NativeConversationChoice {
    return {
        id,
        projectId: 'project-zeus',
        taskId,
        title: id,
        summary: null,
        status: 'active',
        transportKind: 'codex_native',
        providerId: 'codex',
        providerThreadId: `thread-${id}`,
        providerModel: 'gpt-5.6-sol',
        providerState: 'ready',
        createdAt: updatedAt,
        updatedAt,
        archived: false,
        hasUnreadCompletion,
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
        tasks: [
            {
                taskId: 'task-approval',
                taskCode: 'TASK-20260722-001',
                taskTitle: '检查未提交变更',
                conversations: [approvalConversation]
            },
            {
                taskId: 'task-input',
                taskCode: 'TASK-20260722-002',
                taskTitle: '修复已有维护单回调',
                conversations: [inputConversation]
            },
            {
                taskId: 'task-unread',
                taskCode: 'TASK-20260722-003',
                taskTitle: '优化归档会话恢复继续',
                conversations: [unreadConversation]
            },
            {
                taskId: 'task-running',
                taskCode: 'TASK-20260722-004',
                taskTitle: '优化 Codex 会话列表样式',
                conversations: [runningConversation]
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

const commandRequest: NativePendingRequest = {
    id: 'command-approval',
    conversationId: 'approval',
    turnId: 'turn-approval',
    itemId: 'item-command',
    generationId: 'generation-qa',
    type: 'command',
    status: 'pending',
    payload: {
        command: ['/opt/homebrew/bin/mvn', '-pl', 'tc-app-goods-service/tc-app-goods-service-goods', '-am', '-Dtest=SocialGoodsMaintenancePersistenceProviderTest', 'test'],
        cwd: '/Users/david/cckg/tcapp/Back-End/pim/tc-app-goods',
        reason: '是否允许在沙箱外重跑聚焦测试？4 个回调客户端测试仅因沙箱禁止绑定本地端口而报 Socket 错误。',
        availableDecisions: ['accept', {acceptWithExecpolicyAmendment: {execpolicy_amendment: ['/opt/homebrew/bin/mvn', '-pl', 'tc-app-goods-service/tc-app-goods-service-goods']}}, 'decline', 'cancel'],
    },
    response: null,
    containsSecret: false,
    expiresAt: null,
    createdAt: '2026-07-22T08:05:00.000Z',
    resolvedAt: null,
};

function ReferencePanel(props: { title: string; src: string; className?: string }) {
    return (
        <section className={`qa-reference-panel ${props.className ?? ''}`}>
            <h2>{props.title}</h2>
            <img src={`${referenceBase}/${props.src}`} alt={props.title}/>
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
                    <ReferencePanel title="参考：会话进行中 / 完成未读"
                                    src="codex-clipboard-f7c40e26-5276-4c78-aa00-386300113583.png"/>
                    <ReferencePanel title="参考：等待批准" src="codex-clipboard-a4e8a229-5518-4829-ab0d-1dbe7d85e515.png"
                                    className="qa-reference-wide-crop"/>
                </div>
                <section className="qa-implementation-panel" data-testid="conversation-implementation">
                    <h2>Zeus 实现</h2>
                    <div className="session-list-pane qa-session-list">
                        <ProjectConversationTree groups={groups} selectedConversationId="approval"
                                                 conversationStates={conversationStates}
                                                 onSelectConversation={() => undefined}
                                                 onStartConversation={() => undefined} language="zh-CN"/>
                    </div>
                </section>
            </section>

            <section className="qa-comparison qa-approval-comparison">
                <ReferencePanel title="参考：命令审批与类似命令菜单"
                                src="codex-clipboard-a4e8a229-5518-4829-ab0d-1dbe7d85e515.png"/>
                <section className="qa-implementation-panel" data-testid="approval-implementation">
                    <h2>Zeus 实现</h2>
                    <PendingRequestSurface request={commandRequest} language="zh-CN" permissionMode="auto"
                                           onRespond={() => undefined} autoFocus={false}/>
                </section>
            </section>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<App/>);
