import type {TaskRecord} from '../apiClient.js';
import {ConversationTranscript} from '../session/ConversationTranscript.js';
import {createInitialSessionState, sessionReducer} from '../session/sessionReducer.js';
import type {
    NativeConversationAttachment,
    NativeConversationChoice,
    NativeSessionState,
    StartTaskModelPushRequest
} from '../session/sessionTypes.js';
import type {TaskModelPushForm} from './TaskModelPushModal.js';
import {parseTaskAttachments} from './taskAttachments.js';

export type TaskModelPushPendingStatus = 'submitting' | 'failed' | 'accepted';

export interface TaskModelPushPendingState {
    task: TaskRecord;
    projectName: string;
    request: StartTaskModelPushRequest;
    form: TaskModelPushForm;
    prompt: string;
    attachments: NativeConversationAttachment[];
    choice: NativeConversationChoice;
    session: NativeSessionState;
    status: TaskModelPushPendingStatus;
    error: string | null;
}

export function createTaskModelPushPendingState(input: {
    task: TaskRecord;
    projectName: string;
    request: StartTaskModelPushRequest;
    form: TaskModelPushForm;
    prompt: string;
    now?: string
}): TaskModelPushPendingState {
    const now = input.now ?? new Date().toISOString();
    const attachments = parseTaskAttachments(input.task.sourceContextJson).map<NativeConversationAttachment>((attachment) => ({
        name: attachment.name,
        mime: attachment.mimeType ?? (attachment.kind === 'image' ? 'image/*' : 'application/octet-stream'),
        size: 0,
        localPath: attachment.path,
    }));
    const choice: NativeConversationChoice = {
        id: `pending-task-push:${input.request.clientUserMessageId}`,
        projectId: input.task.projectId,
        taskId: input.task.id,
        title: input.task.title,
        summary: null,
        status: 'active',
        transportKind: 'codex_native',
        providerId: 'codex',
        providerThreadId: null,
        providerModel: input.form.model,
        providerState: 'starting',
        createdAt: now,
        updatedAt: now,
        archived: false,
        hasUnreadCompletion: false,
        pendingRequestKind: null,
        resumable: false,
        readOnly: false,
        permissionMode: input.form.permissionMode,
    };
    return {
        ...input,
        attachments,
        choice,
        session: buildOptimisticTaskPushSession(choice, input.request, input.prompt, attachments),
        status: 'submitting',
        error: null,
    };
}

export function retryTaskModelPushPendingState(pending: TaskModelPushPendingState): TaskModelPushPendingState {
    const choice = {
        ...pending.choice,
        status: 'active',
        providerState: 'starting',
        updatedAt: new Date().toISOString()
    };
    return {
        ...pending,
        choice,
        session: buildOptimisticTaskPushSession(choice, pending.request, pending.prompt, pending.attachments),
        status: 'submitting',
        error: null,
    };
}

export function failTaskModelPushPendingState(pending: TaskModelPushPendingState, message: string): TaskModelPushPendingState {
    const items = Object.fromEntries(Object.entries(pending.session.items).map(([key, item]) => [key, item.clientUserMessageId === pending.request.clientUserMessageId ? {
        ...item,
        status: 'failed',
        optimistic: false
    } : item]));
    return {
        ...pending,
        choice: {...pending.choice, status: 'failed', providerState: 'failed', updatedAt: new Date().toISOString()},
        session: {
            ...pending.session,
            conversationState: 'turn_failed',
            items,
            transcriptRevision: pending.session.transcriptRevision + 1,
            error: {message, code: null, recoveryRequired: false, retryable: true},
        },
        status: 'failed',
        error: message,
    };
}

export function acceptTaskModelPushPendingState(pending: TaskModelPushPendingState, choice: NativeConversationChoice): TaskModelPushPendingState {
    const providerThreadId = choice.providerThreadId ?? null;
    return {
        ...pending,
        choice,
        session: buildOptimisticTaskPushSession({
            ...choice,
            providerThreadId
        }, pending.request, pending.prompt, pending.attachments),
        status: 'accepted',
        error: null,
    };
}

function buildOptimisticTaskPushSession(choice: NativeConversationChoice, request: StartTaskModelPushRequest, prompt: string, attachments: NativeConversationAttachment[]): NativeSessionState {
    const base: NativeSessionState = {
        ...createInitialSessionState(),
        transportState: 'ready',
        conversationState: 'native_idle',
        projectId: choice.projectId,
        conversationId: choice.id,
        providerThreadId: choice.providerThreadId,
        providerSettings: {model: request.model, ...(request.effort ? {effort: request.effort} : {})},
    };
    return sessionReducer(base, {
        type: 'send_started',
        clientUserMessageId: request.clientUserMessageId,
        durableClientUserMessageId: request.clientUserMessageId,
        draft: prompt,
        attachments,
        delivery: 'queue',
        previousConversationState: 'native_idle',
    });
}

export function TaskModelPushPendingWorkspace(props: {
    language: 'zh-CN' | 'en-US';
    pending: TaskModelPushPendingState;
    onRetry: () => void
}) {
    const zh = props.language === 'zh-CN';
    const failed = props.pending.status === 'failed';
    return (
        <section
            className="session-workspace-root task-model-push-pending-workspace"
            aria-label={zh ? '会话工作区' : 'Conversation workspace'}
            data-transport-state={failed ? 'failed' : 'ready'}
            data-conversation-state={failed ? 'turn_failed' : 'starting_turn'}
        >
            <header className="session-thread-header" data-motion-title="entered">
        <span className="session-thread-title-copy">
          <strong>{props.pending.task.title}</strong>
          <small>{`${props.pending.projectName} · ${props.pending.task.taskCode ?? props.pending.task.id}`}</small>
        </span>
                <span className={`session-thread-status session-thread-status-${failed ? 'error' : 'busy'}`}
                      role={failed ? 'alert' : 'status'} aria-live={failed ? 'assertive' : 'polite'}>
          <span className="session-status-symbol" aria-hidden="true">
            {failed ? '×' : '◌'}
          </span>
          <span>{failed ? (zh ? '发送失败' : 'Send failed') : zh ? '正在发送' : 'Sending'}</span>
        </span>
            </header>
            <div className="session-thread-body">
                {failed ? (
                    <section className="task-model-push-pending-error" role="alert">
            <span>
              <strong>{zh ? '消息未发送成功' : 'Message was not sent'}</strong>
              <small>{props.pending.error}</small>
            </span>
                        <button type="button" onClick={props.onRetry}>
                            {zh ? '重试发送' : 'Retry send'}
                        </button>
                    </section>
                ) : null}
                <ConversationTranscript state={props.pending.session} language={props.language}/>
            </div>
        </section>
    );
}
