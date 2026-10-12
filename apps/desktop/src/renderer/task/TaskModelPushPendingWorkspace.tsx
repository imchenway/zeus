import { describeUserFacingError, userFacingErrorCause, type UserFacingErrorCause } from '@zeus/shared';
import type { TaskRecord } from '../apiClient.js';
import type { TaskPushContextAttachmentOption, TaskPushMessageLayout } from '@zeus/shared';
import { createInitialSessionState, sessionReducer } from '../session/sessionReducer.js';
import type {
  CodexConversationCapabilities,
  CodexTaskPushModelCapability,
  CodexTaskPushCapabilities,
  NativeConversationAttachment,
  NativeConversationChoice,
  NativeQueuedSubmission,
  NativeSessionState,
  NativeTurnSettingsSelection,
  StartTaskModelPushRequest,
} from '../session/sessionTypes.js';
import { resolveModelCapability } from '../session/modelSelection.js';
import type { TaskModelPushForm } from './TaskModelPushModal.js';
import { parseTaskAttachments } from './taskAttachments.js';

export type TaskModelPushPendingStatus = 'submitting' | 'failed' | 'accepted';

export interface TaskModelPushRetryProgress {
  method: string;
  retryAttempt: number;
  maxRetries: number;
}

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
  /** 保留创建失败原因，不能用失败状态直接决定再次发送。 */
  errorCause?: UserFacingErrorCause;
  /** 只有明确短暂失败且结果已知时才允许再次执行原请求。 */
  canRetry?: boolean;
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
  operationIdentity: string | null;
  retryProgress: TaskModelPushRetryProgress | null;
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
  const currentAttachments = parseTaskAttachments(input.task.sourceContextJson).flatMap<NativeConversationAttachment>((attachment) => {
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
  const attachments = [...currentAttachments, ...input.form.supplementalAttachments];
  const navigationId = `task-push:${input.request.idempotencyKey}`;
  const capabilities = conversationCapabilities(input.capabilities);
  const selectedModel = resolveModelCapability(capabilities.models, input.request.model);
  const choice = createPendingChoice(input.task, navigationId, input.request.model, input.form, selectedModel);
  return {
    ...input,
    navigationId,
    attachments,
    capabilities,
    choice,
    session: buildPendingTaskPushSession(choice, input.request, input.prompt, attachments, input.layout),
    deferredMessages: [],
    contextRefreshRequired: false,
    operationIdentity: null,
    retryProgress: null,
    status: 'submitting',
    error: null,
  };
}

/** 重试保留原消息身份并清除上一轮失败展示，避免连接期间仍显示旧错误。 */
export function retryTaskModelPushPendingState(pending: TaskModelPushPendingState): TaskModelPushPendingState {
  return {
    ...pending,
    session: sessionReducer(pending.session, { type: 'send_accepted', clientUserMessageId: pending.request.clientUserMessageId, status: 'pending' }),
    status: 'submitting',
    error: null,
    retryProgress: null,
  };
}

/** 失败原因归属原消息；配置装载明确拒绝时允许用户修正后手动重试。 */
export function failTaskModelPushPendingState(pending: TaskModelPushPendingState, message: string, error?: unknown): TaskModelPushPendingState {
  /** 原始诊断与用户摘要共用同一份错误链。 */
  const cause = userFacingErrorCause(error ?? message);
  /** 仅明确未执行的配置拒绝和既有安全重试原因开放重试。 */
  const explanation = describeUserFacingError(cause);
  /** 配置加载失败发生在模型请求之前，不把未知送达放行成再次发送。 */
  const canRetry = (explanation.action === 'retry' || explanation.message.startsWith('failed to load configuration:')) && !explanation.outcomeUnconfirmed;
  /** 消息内联反馈与工作面状态保存相同的诊断。 */
  const deliveryError = { message, code: 'ZEUS_TASK_MODEL_PUSH_CREATION_FAILED', recoveryRequired: false, retryable: canRetry, cause };
  /** 失败只更新时间，不改变原消息位置。 */
  const failedAt = new Date().toISOString();
  /** 只标记本次任务首发消息，后续消息不继承该错误。 */
  const failedItems = Object.fromEntries(
    Object.entries(pending.session.items).map(([key, item]) => [
      key,
      item.clientUserMessageId === pending.request.clientUserMessageId
        ? {
            ...item,
            status: explanation.outcomeUnconfirmed ? 'unconfirmed' : 'failed',
            payload: { ...item.payload, deliveryError },
            updatedAt: failedAt,
          }
        : item,
    ]),
  );
  return {
    ...pending,
    choice: {
      ...pending.choice,
      taskPushCreating: false,
      status: 'failed',
      stage: 'failed',
      stageUpdatedAt: failedAt,
      providerState: 'failed',
      updatedAt: failedAt,
      listRuntimeState: 'error',
      taskRunStatus: 'failed',
    },
    session: {
      ...pending.session,
      conversationState: 'turn_failed',
      activeTurnId: null,
      startedTurnId: null,
      items: failedItems,
      transcriptRevision: pending.session.transcriptRevision + 1,
      queue: {
        throughEventSeq: 0,
        state: { type: 'idle' },
        submissions: [],
      },
      error: deliveryError,
    },
    status: 'failed',
    error: message,
    errorCause: cause,
    canRetry,
    retryProgress: null,
  };
}

/** 持久会话身份接管读写；模型尚未连接时由控制器读取原提交失败并提供安全重试。 */
export function attachTaskModelPushChoice(pending: TaskModelPushPendingState, choice: NativeConversationChoice): TaskModelPushPendingState {
  const projectedChoice = { ...choice, navigationId: pending.navigationId, taskPushCreating: true };
  return {
    ...pending,
    choice: projectedChoice,
    session: sessionReducer(remapPendingSession(pending.session, projectedChoice), {
      type: 'send_accepted',
      clientUserMessageId: pending.request.clientUserMessageId,
      status: choice.providerThreadId ? 'active' : 'pending',
    }),
    status: 'submitting',
    error: null,
    retryProgress: null,
  };
}

/** 后续排队消息发送完成后结束任务推送过渡态。 */
export function acceptTaskModelPushPendingState(pending: TaskModelPushPendingState): TaskModelPushPendingState {
  if (!taskModelPushHasRealChoice(pending)) {
    throw new Error('Task model push cannot be accepted before a durable conversation is attached.');
  }
  return {
    ...pending,
    choice: { ...pending.choice, taskPushCreating: false },
    status: 'accepted',
    error: null,
    retryProgress: null,
  };
}

export function identifyTaskModelPushPendingOperation(pending: TaskModelPushPendingState, operationIdentity: string): TaskModelPushPendingState {
  if (pending.operationIdentity === operationIdentity) return pending;
  return { ...pending, operationIdentity, retryProgress: null };
}

export function updateTaskModelPushRetryProgress(pending: TaskModelPushPendingState, retryProgress: TaskModelPushRetryProgress): TaskModelPushPendingState {
  return pending.status === 'submitting' ? { ...pending, retryProgress } : pending;
}

/** 持久会话即可接管失败恢复，不把模型线程创建成功作为读取原消息的前提。 */
export function taskModelPushHasRealChoice(pending: TaskModelPushPendingState): boolean {
  return pending.choice.id !== pending.navigationId;
}

/** 同一次推送只投影一个入口，临时导航身份不能覆盖已接纳的真实会话。 */
export function projectTaskModelPushConversationChoices(pending: TaskModelPushPendingState | undefined, choices: NativeConversationChoice[]): NativeConversationChoice[] {
  if (!pending) return choices;
  /** 仅在同项目、同任务内合并临时入口、真实会话与同一创建操作的目录结果。 */
  const isPendingChoice = (choice: NativeConversationChoice): boolean =>
    choice.projectId === pending.task.projectId &&
    choice.taskId === pending.task.id &&
    (choice.id === pending.navigationId || choice.id === pending.choice.id || (Boolean(pending.operationIdentity) && choice.creationOperationIdentity === pending.operationIdentity));
  /** 创建接纳后采用正式目录状态，目录中残留的临时入口始终没有接管资格。 */
  const authoritativeChoice = pending.status === 'accepted' ? choices.find((choice) => choice.id !== pending.navigationId && isPendingChoice(choice)) : undefined;
  /** 导航身份保持稳定，内部读写身份由真实会话接管。 */
  const projectedChoice = authoritativeChoice ? { ...authoritativeChoice, navigationId: pending.navigationId } : pending.choice;
  return [projectedChoice, ...choices.filter((choice) => !isPendingChoice(choice))];
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
        throughEventSeq: 0,
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
        throughEventSeq: 0,
        state: { type: 'active', turnId: pending.session.activeTurnId ?? `${pending.navigationId}:turn`, phase: 'prework' },
        submissions: deferredMessages.filter((entry) => entry.status !== 'accepted').map(deferredMessageSubmission),
      },
    },
  };
}

function createPendingChoice(task: TaskRecord, navigationId: string, model: string, form: TaskModelPushForm, capability: CodexTaskPushModelCapability | null): NativeConversationChoice {
  const now = new Date().toISOString();
  const agentKind = capability?.agentKind === 'pi' ? 'pi' : 'codex';
  const modelSourceId = capability?.sourceId ?? (agentKind === 'codex' ? 'codex' : null);
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
    providerId: agentKind === 'pi' ? `pi:${modelSourceId ?? 'custom'}` : 'codex',
    providerThreadId: null,
    providerModel: model,
    providerState: 'creating',
    createdAt: now,
    updatedAt: now,
    archived: false,
    hasUnreadAttention: false,
    attentionKind: 'none',
    attentionRevision: 0,
    attentionTurnId: null,
    attentionUpdatedAt: null,
    pendingRequestKind: null,
    listRuntimeState: 'connecting',
    taskRunStatus: 'connecting',
    resumable: true,
    readOnly: false,
    permissionMode: form.permissionMode,
    collaborationMode: form.workMode === 'plan' ? 'plan' : 'default',
    agent: {
      kind: agentKind,
      transport: agentKind === 'pi' ? 'sdk' : 'app_server',
      supportStatus: agentKind === 'pi' ? 'experimental' : 'verified',
      capabilitySnapshotId: null,
    },
    model: {
      sourceId: modelSourceId,
      id: capability?.model ?? model,
    },
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
    queue: { throughEventSeq: 0, state: { type: 'active', turnId, phase: 'prework' }, submissions: [] },
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
    contextDraft: base.contextDraft,
    delivery: 'queue',
    previousConversationState: 'active_prework',
    startedAt: new Date().toISOString(),
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
    goals: { supported: false, enabled: false, stage: null },
  };
}
