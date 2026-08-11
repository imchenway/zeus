import type { TaskRecord } from '../apiClient.js';
import type { TaskPushContextAttachmentOption, TaskPushMessageLayout } from '@zeus/shared';
import { createInitialSessionState, sessionReducer } from '../session/sessionReducer.js';
import type {
  CodexConversationCapabilities,
  CodexTaskPushCapabilities,
  NativeConversationAttachment,
  NativeConversationChoice,
  NativeQueuedSubmission,
  NativeSessionState,
  NativeTurnSettingsSelection,
  StartTaskModelPushRequest,
} from '../session/sessionTypes.js';
import type { TaskModelPushForm } from './TaskModelPushModal.js';
import { parseTaskAttachments } from './taskAttachments.js';

export type TaskModelPushPendingStatus = 'submitting' | 'failed' | 'accepted';

export interface TaskModelPushDeferredMessage {
  id: string;
  idempotencyKey: string;
  clientUserMessageId: string;
  content: string;
  attachments: NativeConversationAttachment[];
  delivery: 'queue' | 'steer_now';
  settings?: NativeTurnSettingsSelection;
  status: 'queued' | 'sending' | 'accepted' | 'failed';
  error: string | null;
}

export interface TaskModelPushPendingState {
  task: TaskRecord;
  projectName: string;
  navigationId: string;
  request: StartTaskModelPushRequest;
  form: TaskModelPushForm;
  prompt: string;
  layout: TaskPushMessageLayout;
  attachments: NativeConversationAttachment[];
  capabilities: CodexConversationCapabilities;
  choice: NativeConversationChoice;
  session: NativeSessionState;
  deferredMessages: TaskModelPushDeferredMessage[];
  contextRefreshRequired: boolean;
  status: TaskModelPushPendingStatus;
  error: string | null;
}

export function createTaskModelPushPendingState(input: {
  task: TaskRecord;
  projectName: string;
  request: StartTaskModelPushRequest;
  form: TaskModelPushForm;
  prompt: string;
  layout: TaskPushMessageLayout;
  currentAttachmentOptions: TaskPushContextAttachmentOption[];
  capabilities: CodexTaskPushCapabilities;
}): TaskModelPushPendingState {
  const currentOptions = new Map<string, TaskPushContextAttachmentOption[]>();
  for (const attachment of input.currentAttachmentOptions) {
    const identity = `${attachment.field}\0${attachment.name}`;
    const options = currentOptions.get(identity) ?? [];
    options.push(attachment);
    currentOptions.set(identity, options);
  }
  const attachments = parseTaskAttachments(input.task.sourceContextJson).flatMap<NativeConversationAttachment>((attachment) => {
    const option = currentOptions.get(`${attachment.field}\0${attachment.name}`)?.shift();
    if (!option?.available) return [];
    return [
      {
        name: attachment.name,
        mime: attachment.mimeType ?? (attachment.kind === 'image' ? 'image/*' : 'application/octet-stream'),
        size: option.size ?? 0,
        kind: attachment.kind,
        localPath: attachment.path,
        taskPushAttachmentKey: option.key,
      },
    ];
  });
  const navigationId = `task-push:${input.request.idempotencyKey}`;
  const choice = createPendingChoice(input.task, navigationId, input.request.model, input.form);
  return {
    ...input,
    navigationId,
    attachments,
    capabilities: conversationCapabilities(input.capabilities),
    choice,
    session: buildPendingTaskPushSession(choice, input.request, input.prompt, attachments, input.layout),
    deferredMessages: [],
    contextRefreshRequired: false,
    status: 'submitting',
    error: null,
  };
}

export function retryTaskModelPushPendingState(pending: TaskModelPushPendingState): TaskModelPushPendingState {
  return {
    ...pending,
    status: 'submitting',
    error: null,
  };
}

export function failTaskModelPushPendingState(pending: TaskModelPushPendingState, message: string): TaskModelPushPendingState {
  return {
    ...pending,
    status: 'failed',
    error: message,
  };
}

/** 真实身份只替换读写目标，稳定导航身份和当前工作面内容保持不变。 */
export function attachTaskModelPushChoice(pending: TaskModelPushPendingState, choice: NativeConversationChoice): TaskModelPushPendingState {
  const projectedChoice = { ...choice, navigationId: pending.navigationId, taskPushCreating: true };
  return {
    ...pending,
    choice: projectedChoice,
    session: remapPendingSession(pending.session, projectedChoice),
    status: 'submitting',
    error: null,
  };
}

export function acceptTaskModelPushPendingState(pending: TaskModelPushPendingState): TaskModelPushPendingState {
  return {
    ...pending,
    choice: { ...pending.choice, taskPushCreating: false },
    status: 'accepted',
    error: null,
  };
}

export function updateTaskModelPushDraft(pending: TaskModelPushPendingState, draft: string): TaskModelPushPendingState {
  return { ...pending, session: sessionReducer(pending.session, { type: 'draft_changed', draft }) };
}

export function updateTaskModelPushAttachments(pending: TaskModelPushPendingState, attachments: NativeConversationAttachment[]): TaskModelPushPendingState {
  return { ...pending, session: sessionReducer(pending.session, { type: 'attachments_changed', attachments }) };
}

export function enqueueTaskModelPushMessage(
  pending: TaskModelPushPendingState,
  input: {
    id: string;
    idempotencyKey: string;
    clientUserMessageId: string;
    content: string;
    attachments: NativeConversationAttachment[];
    delivery: 'queue' | 'steer_now';
    settings?: NativeTurnSettingsSelection;
  },
): TaskModelPushPendingState {
  const message: TaskModelPushDeferredMessage = { ...input, status: 'queued', error: null };
  const deferredMessages = [...pending.deferredMessages, message];
  return {
    ...pending,
    deferredMessages,
    session: {
      ...pending.session,
      draft: '',
      attachments: [],
      queue: {
        state: { type: 'active', turnId: pending.session.activeTurnId ?? `${pending.navigationId}:turn`, phase: 'prework' },
        submissions: deferredMessages.filter((entry) => entry.status !== 'accepted').map(deferredMessageSubmission),
      },
    },
  };
}

export function updateTaskModelPushDeferredMessages(pending: TaskModelPushPendingState, update: (messages: TaskModelPushDeferredMessage[]) => TaskModelPushDeferredMessage[]): TaskModelPushPendingState {
  const deferredMessages = update(pending.deferredMessages);
  return {
    ...pending,
    deferredMessages,
    session: {
      ...pending.session,
      queue: {
        state: { type: 'active', turnId: pending.session.activeTurnId ?? `${pending.navigationId}:turn`, phase: 'prework' },
        submissions: deferredMessages.filter((entry) => entry.status !== 'accepted').map(deferredMessageSubmission),
      },
    },
  };
}

function createPendingChoice(task: TaskRecord, navigationId: string, model: string, form: TaskModelPushForm): NativeConversationChoice {
  const now = new Date().toISOString();
  return {
    id: navigationId,
    navigationId,
    taskPushCreating: true,
    projectId: task.projectId,
    taskId: task.id,
    title: task.title,
    summary: null,
    status: 'creating',
    stage: 'connecting',
    stageUpdatedAt: now,
    transportKind: 'codex_native',
    providerId: 'codex',
    providerThreadId: null,
    providerModel: model,
    providerState: 'creating',
    createdAt: now,
    updatedAt: now,
    archived: false,
    hasUnreadCompletion: false,
    pendingRequestKind: null,
    listRuntimeState: 'connecting',
    taskRunStatus: 'connecting',
    resumable: true,
    readOnly: false,
    permissionMode: form.permissionMode,
    collaborationMode: form.workMode === 'plan' ? 'plan' : 'default',
  };
}

function buildPendingTaskPushSession(choice: NativeConversationChoice, request: StartTaskModelPushRequest, prompt: string, attachments: NativeConversationAttachment[], layout: TaskPushMessageLayout): NativeSessionState {
  const turnId = `${choice.navigationId ?? choice.id}:turn`;
  const base: NativeSessionState = {
    ...createInitialSessionState(),
    transportState: 'ready',
    conversationState: 'active_prework',
    projectId: choice.projectId,
    conversationId: choice.id,
    providerThreadId: `${choice.id}:thread`,
    activeTurnId: turnId,
    startedTurnId: turnId,
    queue: { state: { type: 'active', turnId, phase: 'prework' }, submissions: [] },
    providerSettings: {
      model: request.model,
      ...(request.effort ? { effort: request.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(request, 'serviceTier') ? { serviceTier: request.serviceTier } : {}),
    },
  };
  return sessionReducer(base, {
    type: 'send_started',
    clientUserMessageId: request.clientUserMessageId,
    durableClientUserMessageId: request.clientUserMessageId,
    draft: prompt,
    attachments,
    submittedAttachments: attachments,
    browserSubmission: null,
    browserComments: [],
    delivery: 'queue',
    previousConversationState: 'active_prework',
    taskPushLayout: layout,
  });
}

function remapPendingSession(session: NativeSessionState, choice: NativeConversationChoice): NativeSessionState {
  const providerThreadId = choice.providerThreadId ?? session.providerThreadId;
  return {
    ...session,
    projectId: choice.projectId,
    conversationId: choice.id,
    providerThreadId,
    items: Object.fromEntries(Object.entries(session.items).map(([key, item]) => [key, { ...item, conversationId: choice.id, threadId: providerThreadId ?? item.threadId }])),
  };
}

function deferredMessageSubmission(message: TaskModelPushDeferredMessage, position: number): NativeQueuedSubmission {
  return {
    id: message.id,
    content: message.content,
    status: message.status === 'failed' ? 'failed' : 'queued',
    delivery: message.delivery,
    attachments: message.attachments,
    clientUserMessageId: message.clientUserMessageId,
    position,
    pausedReason: null,
    error: message.error ? { code: 'ZEUS_TASK_PUSH_DEFERRED_SEND_FAILED', message: message.error, recoveryRequired: false } : null,
  };
}

function conversationCapabilities(capabilities: CodexTaskPushCapabilities): CodexConversationCapabilities {
  return {
    generationId: capabilities.generationId,
    initializedAt: capabilities.initializedAt,
    projectId: capabilities.projectId,
    preferredModel: capabilities.preferredModel,
    models: capabilities.models,
    codexAccount: capabilities.codexAccount,
  };
}
