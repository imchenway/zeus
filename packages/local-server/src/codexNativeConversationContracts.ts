import type { CodexServerRequestResponse } from '@zeus/ai-runtime';
import type { TaskPushMessageLayout } from '@zeus/shared';
import type { ConversationCollaborationMode, ConversationPermissionMode } from '@zeus/storage';

export type NativeConversationRunState =
  | { type: 'idle' }
  | { type: 'dispatching'; submissionId: string }
  | { type: 'active'; turnId: string; phase: 'prework' | 'final_answer' }
  | { type: 'waiting'; turnId: string; requestId: string; reason: 'approval' | 'user_input' }
  | { type: 'paused'; reason: 'interrupted' | 'transport_unavailable' | 'provider_archived' | 'recovery_required' };

export type NativeOperationStatus = 'queued' | 'active' | 'steering' | 'steered' | 'interrupted' | 'responded' | 'provider_archived' | 'recovery_required';

export interface NativeAcceptedOperation {
  operationId: string;
  conversationId: string;
  submissionId: string;
  status: NativeOperationStatus;
  providerThreadId: string | null;
  providerTurnId: string | null;
}

export interface NativeSubmissionError {
  code: string;
  message: string;
  recoveryRequired: boolean;
}

export interface NativeQueuedSubmission {
  id: string;
  conversationId: string;
  content: string;
  status: 'queued' | 'paused';
  delivery: 'queue' | 'steer_now';
  attachments: NativeConversationAttachmentInput[];
  expectedTurnId: string | null;
  clientUserMessageId: string;
  position: number;
  providerTurnId: null;
  pausedReason: string | null;
  error: NativeSubmissionError | null;
  createdAt: string;
  updatedAt: string;
}

export interface NativeQueueSnapshot {
  conversationId: string;
  state: NativeConversationRunState;
  submissions: NativeQueuedSubmission[];
}

export interface LegacyConversationReference {
  conversationId: string;
  messageIds: string[];
}

export interface NativeProviderWriteLifecycle {
  markPrepared(resourceId: string): Promise<void>;
  markRpcStarted(resourceId: string): void;
}

export interface NativeConversationAttachmentInput {
  name: string;
  mime: string;
  size: number;
  localPath?: string;
  uploadRef?: string;
  /** Local Server 验签后写入的精确路径授权；API 调用方不能自行声明。 */
  authorizedPath?: string;
  /** 任务首发服务端快照中的附件位置身份；普通会话附件不填写。 */
  taskPushAttachmentKey?: string;
}

export interface NativeQuestionAnswerAttachmentInput {
  questionId: string;
  attachments: NativeConversationAttachmentInput[];
}

export interface StartTaskConversationInput {
  conversationId?: string;
  submissionId?: string;
  projectId: string;
  projectLocalPath: string;
  taskId: string;
  workspaceId?: string;
  environmentId?: string;
  conversationTitle?: string;
  /** 多仓任务只把逐仓 worktree 与显式共享目录授予写权限。 */
  writableRoots?: string[];
  taskTitle: string;
  prompt: string;
  displayText?: string;
  model: string;
  effort?: string;
  serviceTier?: string | null;
  allowCodeChanges: boolean;
  allowTests: boolean;
  allowGitCommit: boolean;
  permissionMode?: ConversationPermissionMode;
  idempotencyKey: string;
  clientUserMessageId: string;
  attachments?: NativeConversationAttachmentInput[];
  taskPushLayout?: TaskPushMessageLayout;
  /** 服务端预检后允许 Codex 读取附件的目录；不接受 Renderer 自报信任根。 */
  allowedAttachmentRoots?: string[];
  /** 用户明确触发并等待结果的任务操作直接创建 app-server thread/turn，不进入普通会话并发队列。 */
  bypassConcurrency?: boolean;
  /** 会话与首条消息持久接受后立即返回，由后台队列启动 Provider；用于先进入会话再展示准备结果。 */
  deferInitialDispatch?: boolean;
  /** Codex composer 的协作模式，仅用于显式任务推送。 */
  workMode?: 'default' | 'plan';
  /** 新推送链路不再读取任务表中的 allow* 兼容字段。 */
  applyLegacyTaskGuards?: boolean;
  legacyReference?: LegacyConversationReference;
  ephemeral?: boolean;
  providerWriteLifecycle?: NativeProviderWriteLifecycle;
}

export interface StartProjectConversationInput {
  conversationId?: string;
  submissionId?: string;
  projectId: string;
  projectLocalPath: string;
  prompt: string;
  model: string;
  effort?: string;
  serviceTier?: string | null;
  permissionMode?: ConversationPermissionMode;
  collaborationMode?: ConversationCollaborationMode;
  idempotencyKey: string;
  clientUserMessageId: string;
  attachments?: NativeConversationAttachmentInput[];
  providerWriteLifecycle?: NativeProviderWriteLifecycle;
}

export interface SubmitNativeMessageInput {
  conversationId: string;
  submissionId?: string;
  content: string;
  displayText?: string;
  attachments?: NativeConversationAttachmentInput[];
  browserComments?: Record<string, unknown>[];
  model?: string;
  effort?: string;
  serviceTier?: string | null;
  permissionMode?: ConversationPermissionMode;
  collaborationMode?: ConversationCollaborationMode;
  idempotencyKey: string;
  clientUserMessageId: string;
  providerWriteLifecycle?: NativeProviderWriteLifecycle;
}

export interface SteerNativeMessageInput {
  conversationId: string;
  content: string;
  displayText?: string;
  attachments?: NativeConversationAttachmentInput[];
  browserComments?: Record<string, unknown>[];
  expectedTurnId: string;
  idempotencyKey: string;
  clientUserMessageId: string;
  /** 只用于询问回答附件的内部交付投影，普通消息 API 不接受该字段。 */
  requestAnswerId?: string;
  providerWriteLifecycle?: NativeProviderWriteLifecycle;
}

export interface RespondPlanImplementationRequestInput {
  conversationId: string;
  requestId: string;
  action: 'implement' | 'refine' | 'dismiss';
  feedback?: string;
}

export interface EditQueuedSubmissionInput {
  conversationId: string;
  submissionId: string;
  content: string;
}

export interface DeleteQueuedSubmissionInput {
  conversationId: string;
  submissionId: string;
}

export interface ReorderNativeQueueInput {
  conversationId: string;
  orderedSubmissionIds: string[];
}

export interface SendQueuedNowInput {
  conversationId: string;
  submissionId: string;
  providerWriteLifecycle?: NativeProviderWriteLifecycle;
}

export interface ResumeNativeQueueInput {
  conversationId: string;
}

export interface RecoverNativeQueueInput {
  conversationId: string;
}

export interface RestoreArchivedConversationInput {
  conversationId: string;
}

export interface ArchiveConversationInput {
  conversationId: string;
}

export interface InterruptNativeTurnInput {
  conversationId: string;
  providerTurnId: string;
  providerWriteLifecycle?: NativeProviderWriteLifecycle;
}

type NativeServerRequestResponse = CodexServerRequestResponse extends infer Response ? (Response extends CodexServerRequestResponse ? Omit<Response, 'generationId' | 'requestId'> : never) : never;

export interface RespondNativeRequestInput {
  requestId: string;
  response: NativeServerRequestResponse;
  answerAttachments?: NativeQuestionAnswerAttachmentInput[];
  /** 仅用于已回答记录的受控展示元数据，不发送给 Provider。 */
  answerAttachmentPresentation?: Record<string, Array<Record<string, unknown>>>;
  providerWriteLifecycle?: NativeProviderWriteLifecycle;
}

export interface SnoozeNativeRequestInput {
  requestId: string;
}

export interface StartNativeEphemeralConversationInput {
  projectId: string;
  projectLocalPath: string;
  title: string;
  prompt: string;
  model: string;
  effort?: string;
  serviceTier?: string | null;
  idempotencyKey: string;
  clientUserMessageId: string;
}

export interface NativeTurnResult {
  conversationId: string;
  providerThreadId: string;
  providerTurnId: string;
  status: 'completed' | 'interrupted';
  answer: string;
}

export interface WaitForNativeTurnResultInput {
  conversationId: string;
  providerTurnId: string;
  timeoutMs?: number;
}

export interface CodexNativeConversationCoordinator {
  startTaskConversation(input: StartTaskConversationInput): Promise<NativeAcceptedOperation>;
  startProjectConversation(input: StartProjectConversationInput): Promise<NativeAcceptedOperation>;
  submitMessage(input: SubmitNativeMessageInput): Promise<NativeAcceptedOperation>;
  steerMessage(input: SteerNativeMessageInput): Promise<NativeAcceptedOperation>;
  editQueuedSubmission(input: EditQueuedSubmissionInput): Promise<NativeQueueSnapshot>;
  deleteQueuedSubmission(input: DeleteQueuedSubmissionInput): Promise<NativeQueueSnapshot>;
  reorderQueue(input: ReorderNativeQueueInput): Promise<NativeQueueSnapshot>;
  sendQueuedNow(input: SendQueuedNowInput): Promise<NativeAcceptedOperation>;
  resumeInterruptedQueue(input: ResumeNativeQueueInput): Promise<NativeQueueSnapshot>;
  recoverQueue(input: RecoverNativeQueueInput): Promise<NativeQueueSnapshot>;
  archiveConversation(input: ArchiveConversationInput): Promise<NativeQueueSnapshot>;
  restoreArchivedConversation(input: RestoreArchivedConversationInput): Promise<NativeQueueSnapshot>;
  interruptTurn(input: InterruptNativeTurnInput): Promise<NativeAcceptedOperation>;
  respondToRequest(input: RespondNativeRequestInput): Promise<NativeAcceptedOperation>;

  snoozeRequest(input: SnoozeNativeRequestInput): Promise<void>;

  respondToPlanImplementationRequest(input: RespondPlanImplementationRequestInput): Promise<NativeAcceptedOperation>;
  recover(): Promise<void>;
  capacityChanged(): Promise<void>;
  close(): Promise<void>;
}
