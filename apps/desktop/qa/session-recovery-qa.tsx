import React, {useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import type {ConversationResource} from '@zeus/shared';
import type {
    CodexConversationCapabilities,
    NativeConversationAttachment,
    NativeConversationChoice,
    NativeConversationResourceV2Item,
    NativeConversationSnapshotV2,
    NativeConversationSnapshotV2Page,
    NativeQueuedSubmission,
} from '../src/renderer/session/sessionTypes.js';
import {SessionWorkspace} from '../src/renderer/session/SessionWorkspace.js';
import {createHydratedSessionState, sessionReducer} from '../src/renderer/session/sessionReducer.js';
import {createSessionController, type SessionControllerClient} from '../src/renderer/session/useSessionController.js';
import {adaptConversationSnapshotV2} from '../src/renderer/session/conversationSnapshotV2Adapter.js';
import {conversation} from './session-qa-fixtures.js';

const zeus0388ConversationId = 'zeus-0388-history-conversation';
const zeus0388LocalTurnId = 'zeus-0388-local-turn';
const zeus0388ProviderTurnId = 'zeus-0388-provider-turn';
const zeus0388Choice: NativeConversationChoice = {
    ...conversation(zeus0388ConversationId, 'task-zeus-0388', '2026-08-29T04:00:00.000Z'),
    title: '会话附件与历史续聊',
};
const zeus0388SnapshotV2: NativeConversationSnapshotV2 = {
    schemaVersion: 2,
    structureGeneration: '2026-08-29-conversation-snapshot-v2-recovered-request-input',
    conversationSchemaGeneration: '2026-08-16-unified-conversation-segments',
    throughEventSeq: 8,
    eventStreamGeneration: 'zeus-conversation-sync-v2',
    conversation: {
        id: zeus0388ConversationId,
        projectId: 'project-zeus',
        taskId: 'task-zeus-0388',
        title: '会话附件与历史续聊',
        titleRedacted: false,
        status: 'starting',
        stage: 'completed',
        stageUpdatedAt: '2026-08-29T04:00:00.000Z',
        archived: false,
        transportKind: 'codex_native',
        providerState: 'ready',
        providerModel: 'gpt-5.6-sol',
        providerSettings: {model: 'gpt-5.6-sol', effort: 'xhigh'},
        nextTurnSettings: {model: 'gpt-5.6-sol', effort: 'xhigh', permissionMode: 'auto', collaborationMode: 'default'},
        agentKind: 'codex',
        createdAt: '2026-08-29T03:30:00.000Z',
        updatedAt: '2026-08-29T04:00:00.000Z',
    },
    openSegment: null,
    activeTurn: null,
    recentClosedTurns: [
        {
            id: zeus0388LocalTurnId,
            providerTurnId: zeus0388ProviderTurnId,
            submissionId: null,
            status: 'completed',
            hasError: false,
            hasPlan: false,
            plan: null,
            startedAt: '2026-08-29T03:45:00.000Z',
            completedAt: '2026-08-29T03:59:00.000Z',
            createdAt: '2026-08-29T03:45:00.000Z',
            updatedAt: '2026-08-29T03:59:00.000Z',
            agentKind: 'codex',
            openingUserMessage: null,
            process: {available: true, latestSequence: 4},
            resourcesAvailable: true,
            changeSetAvailable: false,
        },
    ],
    sessionMetrics: null,
    collections: {
        timeline: {throughSequence: 8},
        modelHistory: {throughSequence: 2},
        process: {throughSequence: 4},
        resources: {available: true, assistantDeliverablesAvailable: true},
    },
    limits: {closedTurnLimit: 8, byteLimit: 96 * 1024, returnedTurnCount: 1, responseBytes: 2_048},
};
const zeus0388HistoryPage: NativeConversationSnapshotV2Page<import('../src/renderer/session/sessionTypes.js').NativeConversationModelHistoryV2Item> = {
    schemaVersion: 2,
    structureGeneration: '2026-08-29-conversation-snapshot-v2-recovered-request-input',
    conversationId: zeus0388ConversationId,
    kind: 'model_history',
    throughEventSeq: 8,
    throughSequence: 2,
    items: [
        {
            id: 'zeus-0388-final-answer',
            sequence: 2,
            turnId: zeus0388LocalTurnId,
            submissionId: null,
            clientUserMessageId: null,
            providerItemId: 'zeus-0388-final-answer-provider-item',
            reasoningSummary: false,
            phase: 'final_answer',
            segmentId: 'zeus-0388-segment',
            role: 'assistant',
            toolPairId: null,
            confirmedAt: '2026-08-29T03:59:00.000Z',
            content: {
                preview: '已完成三张原型图。请选择 1、2、3，或告诉我希望组合哪些部分。',
                byteLength: 96,
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
    limits: {entryLimit: 48, byteLimit: 96 * 1024, returnedItems: 1, responseBytes: 512},
};
const zeus0388AssistantResources: NativeConversationResourceV2Item[] = [
    ...Array.from(
        {length: 3},
        (_, index): NativeConversationResourceV2Item => ({
            id: `zeus-0388-deliverable-${index + 1}`,
            turnId: zeus0388LocalTurnId,
            itemId: `zeus-0388-image-generation-${index + 1}`,
            sourceIndex: 0,
            kind: 'attachment',
            presentation: 'card',
            displayName: `原型图 ${index + 1}`,
            mimeType: 'image/png',
            previewKind: 'image',
            iconKind: 'image',
            attachmentRef: `zeus-0388-prototype-${index + 1}`,
            taskPushAttachmentKey: null,
            origin: 'provider_generated_image',
            delivery: 'assistant',
            createdAt: `2026-08-29T03:5${index}:00.000Z`,
            updatedAt: `2026-08-29T03:5${index}:00.000Z`,
            accessPolicy: 'authorized_open_intent_or_preview',
        }),
    ),
    {
        id: 'zeus-0388-report-deliverable',
        turnId: zeus0388LocalTurnId,
        itemId: 'zeus-0388-report-file',
        sourceIndex: 0,
        kind: 'file',
        presentation: 'card',
        displayName: 'ZEUS-0389 调研报告.md',
        mimeType: 'text/markdown',
        previewKind: 'document',
        iconKind: 'file',
        origin: 'provider_generated_file',
        delivery: 'assistant',
        createdAt: '2026-08-29T03:57:30.000Z',
        updatedAt: '2026-08-29T03:57:30.000Z',
        accessPolicy: 'authorized_open_intent_or_preview',
    },
];
const zeus0388OrdinaryImageResource: NativeConversationResourceV2Item = {
    id: 'zeus-0388-ordinary-image-view',
    turnId: zeus0388LocalTurnId,
    itemId: 'zeus-0388-image-view-item',
    sourceIndex: 0,
    kind: 'attachment',
    presentation: 'card',
    displayName: '普通处理过程截图',
    mimeType: 'image/png',
    previewKind: 'image',
    iconKind: 'image',
    attachmentRef: 'zeus-0388-image-view',
    taskPushAttachmentKey: null,
    origin: 'provider_image_view',
    delivery: null,
    createdAt: '2026-08-29T03:58:30.000Z',
    updatedAt: '2026-08-29T03:58:30.000Z',
    accessPolicy: 'authorized_open_intent_or_preview',
};
const zeus0388ResourceItems: NativeConversationResourceV2Item[] = [
    ...zeus0388AssistantResources,
    zeus0388OrdinaryImageResource,
    ...Array.from(
        {length: 141},
        (_, index): NativeConversationResourceV2Item => ({
            id: `zeus-0388-ordinary-resource-${index + 1}`,
            turnId: zeus0388LocalTurnId,
            itemId: `zeus-0388-tool-file-${index + 1}`,
            sourceIndex: 0,
            kind: 'file',
            presentation: 'inline',
            displayName: `过程资源 ${index + 1}.txt`,
            mimeType: 'text/plain',
            previewKind: 'document',
            iconKind: 'file',
            origin: 'provider_tool_output',
            delivery: null,
            createdAt: '2026-08-29T03:58:45.000Z',
            updatedAt: '2026-08-29T03:58:45.000Z',
            accessPolicy: 'authorized_open_intent_or_preview',
        }),
    ),
];
const zeus0388ResourceCursors = ['zeus-0388-resource-page-2', 'zeus-0388-resource-page-3', 'zeus-0388-resource-page-4', 'zeus-0388-resource-page-5'] as const;
const zeus0388ResourcePages: NativeConversationSnapshotV2Page<NativeConversationResourceV2Item>[] = Array.from({length: 5}, (_, index) => {
    const items = zeus0388ResourceItems.slice(index * 32, (index + 1) * 32);
    return {
        schemaVersion: 2,
        structureGeneration: '2026-08-29-conversation-snapshot-v2-recovered-request-input',
        conversationId: zeus0388ConversationId,
        kind: 'resources',
        throughEventSeq: 8,
        throughSequence: 0,
        items,
        hasMore: index < 4,
        nextCursor: zeus0388ResourceCursors[index] ?? null,
        limits: {entryLimit: 32, byteLimit: 64 * 1024, returnedItems: items.length, responseBytes: items.length * 512},
    };
});
const zeus0388ResourcePageIndexByCursor = new Map(zeus0388ResourceCursors.map((cursor, index) => [cursor, index + 1]));
const zeus0388InitialSnapshot = adaptConversationSnapshotV2({
    snapshot: zeus0388SnapshotV2,
    history: zeus0388HistoryPage,
    queue: {state: {type: 'idle'}, submissions: []},
    requests: [],
    planImplementationRequests: [],
    choice: zeus0388Choice,
    goal: {goal: null, timeline: [], capability: {supported: false, enabled: false, stage: null, reason: 'unverified'}},
});
const zeus0388InitialSessionState = createHydratedSessionState(zeus0388InitialSnapshot);
const zeus0388Attachment: NativeConversationAttachment = {
    name: '续聊附件.png',
    mime: 'image/png',
    size: 68,
    kind: 'image',
    source: 'picker',
    uploadRef: 'zeus-0388-qa-attachment',
};
const zeus0388RecoveredSubmission: NativeQueuedSubmission = {
    id: 'zeus-0388-recovered-submission',
    conversationId: zeus0388ConversationId,
    content: '重启前尚未确认的消息',
    status: 'paused',
    delivery: 'queue',
    position: 0,
    providerTurnId: null,
    pausedReason: 'recovered_unsent',
    createdAt: '2026-08-29T04:01:00.000Z',
    updatedAt: '2026-08-29T04:01:00.000Z',
};
const zeus0388Capabilities: CodexConversationCapabilities = {
    generationId: 'zeus-0388-qa-capabilities',
    initializedAt: '2026-08-29T04:00:00.000Z',
    projectId: 'project-zeus',
    preferredModel: 'gpt-5.6-sol',
    models: [
        {
            id: 'gpt-5.6-sol',
            model: 'gpt-5.6-sol',
            displayName: 'GPT-5.6 Sol',
            agentKind: 'codex',
            available: true,
            supportedReasoningEfforts: ['high', 'xhigh'],
            defaultReasoningEffort: 'xhigh',
            serviceTiers: [],
        },
        {
            id: 'gpt-5.6-luna',
            model: 'gpt-5.6-luna',
            displayName: 'GPT-5.6 Luna',
            agentKind: 'codex',
            available: true,
            supportedReasoningEfforts: ['medium', 'high'],
            defaultReasoningEffort: 'medium',
            serviceTiers: [],
        },
    ],
    codexAccount: {
        generationId: 'zeus-0388-qa-account',
        requiresOpenaiAuth: false,
        signedIn: true,
        accountType: 'chatgpt',
        planType: 'qa',
    },
};

export function Zeus0388QaApp() {
    const [resourceRequests, setResourceRequests] = useState(0);
    const [submitCount, setSubmitCount] = useState(0);
    const [historyTransitions, setHistoryTransitions] = useState(0);
    const [settingsChanges, setSettingsChanges] = useState(0);
    const [historyOnly, setHistoryOnly] = useState(true);
    const [guard, setGuard] = useState<'writable' | 'archived' | 'explicit-readonly' | 'nonresumable' | 'processing' | 'task-ended' | 'recovered'>('writable');
    const controller = useMemo(
        () =>
            createSessionController({
                client: {
                    async loadNativeConversationResourcesV2(_projectId, _conversationId, options) {
                        setResourceRequests((count) => count + 1);
                        return zeus0388ResourcePages[options?.cursor ? (zeus0388ResourcePageIndexByCursor.get(options.cursor) ?? 0) : 0]!;
                    },
                } as unknown as SessionControllerClient,
                projectId: 'project-zeus',
                conversationId: zeus0388ConversationId,
                initialCachedState: zeus0388InitialSessionState,
                storage: {getItem: () => null, setItem: () => undefined, removeItem: () => undefined},
            }),
        [],
    );
    const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
    useEffect(() => () => controller.dispose(), [controller]);

    const visibleConversation = {
        ...zeus0388Choice,
        archived: guard === 'archived',
        readOnly: guard === 'explicit-readonly',
        resumable: guard !== 'nonresumable',
    };
    // QA 直接注入已经水合的历史快照，不建立真实 socket；用 ready 表达本地快照可读，
    // 使资源自动加载 effect 与正式历史工作面保持同一前置条件。
    const hydratedHistoryState = {
        ...state,
        transportState: 'ready' as const,
        conversationState: 'starting_turn' as const
    };
    const visibleState =
        guard === 'recovered'
            ? {
                ...hydratedHistoryState,
                queue: {
                    state: {type: 'paused' as const, reason: 'recovered_unsent' as const},
                    waitReason: 'recovered_unsent' as const,
                    submissions: [zeus0388RecoveredSubmission]
                },
            }
            : guard === 'processing'
                ? {
                    ...hydratedHistoryState,
                    activeTurnId: zeus0388ProviderTurnId,
                    startedTurnId: zeus0388ProviderTurnId,
                    conversationState: 'waiting_user_input' as const,
                    queue: {
                        state: {
                            type: 'waiting' as const,
                            turnId: zeus0388ProviderTurnId,
                            requestId: 'zeus-0388-request-input',
                            reason: 'user_input' as const
                        },
                        waitReason: 'user_input' as const,
                        submissions: [],
                    },
                }
                : hydratedHistoryState;
    const taskEndedGate =
        guard === 'task-ended'
            ? {
                title: '此任务已结束，会话当前为只读',
                description: '重新打开任务后才能继续对话。',
                actionLabel: '重新打开任务并继续',
                onAction: () => undefined,
            }
            : undefined;
    const deliverableItems = Object.values(state.items).filter((item) => item.resources.some((resource) => resource.delivery === 'assistant'));
    const authoritativeRefreshState = useMemo(() => sessionReducer(state, {
        type: 'snapshot_hydrated',
        snapshot: zeus0388InitialSnapshot
    }), [state]);
    const refreshedDeliverableItems = Object.values(authoritativeRefreshState.items).filter((item) => item.resources.some((resource) => resource.delivery === 'assistant'));
    const reportFileProjected = deliverableItems.some((item) => item.resources.some((resource) => resource.displayName === 'ZEUS-0389 调研报告.md'));
    const ordinaryImageViewProjected = Object.values(state.items).some((item) => item.resources.some((resource) => resource.id === 'zeus-0388-ordinary-image-view'));

    const selectGuard = (next: typeof guard): void => {
        setGuard(next);
        setHistoryOnly(true);
    };

    return (
        <main className="macos-ai-app zeus-shell qa-page qa-motion-page" data-testid="zeus-0388-qa">
            <header className="qa-heading">
                <p>ZEUS-0388 · Snapshot V2 交付附件与历史续聊</p>
                <h1>冷历史恢复正式附件，输入区按真实写权限启用</h1>
            </header>
            <section className="qa-motion-theme session-codex-parity-v1 theme-light" data-testid="zeus-0388-evidence">
                <div className="qa-motion-fixture-actions">
                    <button type="button" onClick={() => selectGuard('writable')}>
                        可续接历史
                    </button>
                    <button type="button" onClick={() => selectGuard('archived')}>
                        归档会话
                    </button>
                    <button type="button" onClick={() => selectGuard('explicit-readonly')}>
                        显式只读
                    </button>
                    <button type="button" onClick={() => selectGuard('nonresumable')}>
                        不可续接
                    </button>
                    <button type="button" onClick={() => selectGuard('processing')}>
                        请求处理中
                    </button>
                    <button type="button" onClick={() => selectGuard('task-ended')}>
                        任务结束
                    </button>
                    <button type="button" onClick={() => selectGuard('recovered')}>
                        待恢复消息
                    </button>
                </div>
                <output data-testid="zeus-0388-resource-evidence">
                    资源请求 {resourceRequests} 次 · 助手交付项 {deliverableItems.length} 个 ·
                    权威对账后 {refreshedDeliverableItems.length} 个 ·
                    调研报告 {reportFileProjected ? '可见' : '缺失'} · 普通过程图片未提升{' '}
                    {ordinaryImageViewProjected ? '失败' : '通过'}
                </output>
                <output data-testid="zeus-0388-compose-evidence">
                    {historyOnly ? '历史快照' : '交互模式'} · 首次切换 {historyTransitions} 次 · 发送 {submitCount} 次 ·
                    配置变更 {settingsChanges} 次 · 输入附件 {visibleState.attachments.length} 个 · 门禁 {guard}
                </output>
            </section>
            <section className="qa-implementation-panel" style={{blockSize: 920}} data-testid="zeus-0388-workspace">
                <SessionWorkspace
                    language="zh-CN"
                    state={visibleState}
                    conversation={visibleConversation}
                    task={null}
                    owner={{kind: 'project', projectId: 'project-zeus', projectName: 'Zeus'}}
                    capabilities={zeus0388Capabilities}
                    historyOnly={historyOnly}
                    suppressComposer={guard === 'task-ended'}
                    readOnlyGate={taskEndedGate}
                    quickActionsSuppressed
                    actions={{
                        onDraftChange: (draft) => controller.setDraft(draft),
                        onSubmit: () => {
                            setSubmitCount((count) => count + 1);
                            setHistoryOnly((current) => {
                                if (current) setHistoryTransitions((count) => count + 1);
                                return false;
                            });
                            controller.setDraft('');
                        },
                        onChooseAttachments: () => controller.setAttachments([...state.attachments, zeus0388Attachment]),
                        onRemoveAttachment: (attachment) => controller.setAttachments(state.attachments.filter((candidate) => candidate !== attachment)),
                        onNextTurnSettingsChange: () => setSettingsChanges((count) => count + 1),
                        onLoadConversationResources: () => controller.loadConversationResources(),
                        onLoadResourcePreview: async (resource) => ({
                            kind: 'image',
                            resource: resource as Extract<ConversationResource, { kind: 'attachment' }>,
                            mimeType: 'image/png',
                            dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                            byteLength: 68,
                        }),
                    }}
                />
            </section>
        </main>
    );
}
