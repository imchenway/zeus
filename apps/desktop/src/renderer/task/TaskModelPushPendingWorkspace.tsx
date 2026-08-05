import type { TaskRecord } from '../apiClient.js';
import { createInitialSessionState, sessionReducer } from '../session/sessionReducer.js';
import type { NativeConversationAttachment, NativeConversationChoice, NativeSessionState, StartTaskModelPushRequest } from '../session/sessionTypes.js';
import type { TaskModelPushForm } from './TaskModelPushModal.js';
import { parseTaskAttachments } from './taskAttachments.js';

export type TaskModelPushPendingStatus = 'submitting' | 'failed' | 'accepted';

export interface TaskModelPushPendingState {
  task: TaskRecord;
  projectName: string;
  request: StartTaskModelPushRequest;
  form: TaskModelPushForm;
  prompt: string;
  attachments: NativeConversationAttachment[];
  choice: NativeConversationChoice | null;
  session: NativeSessionState | null;
  status: TaskModelPushPendingStatus;
  error: string | null;
}

export function createTaskModelPushPendingState(input: { task: TaskRecord; projectName: string; request: StartTaskModelPushRequest; form: TaskModelPushForm; prompt: string }): TaskModelPushPendingState {
  const attachments = parseTaskAttachments(input.task.sourceContextJson).map<NativeConversationAttachment>((attachment) => ({
    name: attachment.name,
    mime: attachment.mimeType ?? (attachment.kind === 'image' ? 'image/*' : 'application/octet-stream'),
    size: 0,
    localPath: attachment.path,
  }));
  return {
    ...input,
    attachments,
    choice: null,
    session: null,
    status: 'submitting',
    error: null,
  };
}

export function retryTaskModelPushPendingState(pending: TaskModelPushPendingState): TaskModelPushPendingState {
  return {
    ...pending,
    choice: null,
    session: null,
    status: 'submitting',
    error: null,
  };
}

export function failTaskModelPushPendingState(pending: TaskModelPushPendingState, message: string): TaskModelPushPendingState {
  return {
    ...pending,
    choice: null,
    session: null,
    status: 'failed',
    error: message,
  };
}

export function acceptTaskModelPushPendingState(pending: TaskModelPushPendingState, choice: NativeConversationChoice): TaskModelPushPendingState {
  const providerThreadId = choice.providerThreadId ?? null;
  return {
    ...pending,
    choice,
    session: buildOptimisticTaskPushSession(
      {
        ...choice,
        providerThreadId,
      },
      pending.request,
      pending.prompt,
      pending.attachments,
    ),
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
    // 用户请求值不能伪装成 Runtime 已确认的实际设置。
    providerSettings: null,
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
    previousConversationState: 'native_idle',
  });
}
