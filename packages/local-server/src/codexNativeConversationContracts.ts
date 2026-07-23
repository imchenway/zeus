import type {CodexServerRequestResponse} from '@zeus/ai-runtime';
import type {ConversationCollaborationMode, ConversationPermissionMode} from '@zeus/storage';

export type NativeConversationRunState =
  | { type: 'idle' }
  | { type: 'dispatching'; submissionId: string }
  | { type: 'active'; turnId: string; phase: 'prework' | 'final_answer' }
  | { type: 'waiting'; turnId: string; requestId: string; reason: 'approval' | 'user_input' }
    | { type: 'paused'; reason: 'interrupted' | 'transport_unavailable' | 'provider_archived' | 'recovery_required' };

export type NativeOperationStatus =
    'queued'
    | 'active'
    | 'steered'
    | 'interrupted'
    | 'responded'
    | 'provider_archived'
    | 'recovery_required';

export interface NativeAcceptedOperation {
  operationId: string;
  conversationId: string;
  submissionId: string;
  status: NativeOperationStatus;
  providerThreadId: string | null;
  providerTurnId: string | null;
}

export interface NativeQueuedSubmission {
  id: string;
  content: string;
  status: 'queued' | 'paused' | 'failed';
  position: number;
  pausedReason: string | null;
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
}

export interface StartTaskConversationInput {
  conversationId?: string;
  submissionId?: string;
  projectId: string;
  projectLocalPath: string;
  taskId: string;
  taskTitle: string;
  prompt: string;
  model: string;
  effort?: string;
  allowCodeChanges: boolean;
  allowTests: boolean;
  allowGitCommit: boolean;
  permissionMode?: ConversationPermissionMode;
  idempotencyKey: string;
  clientUserMessageId: string;
  attachments?: NativeConversationAttachmentInput[];
  /** 服务端预检后允许 Codex 读取附件的目录；不接受 Renderer 自报信任根。 */
  allowedAttachmentRoots?: string[];
  /** 任务“推送到模型”直接创建 app-server thread/turn，不复用旧 CLI Runtime 并发队列。 */
  bypassConcurrency?: boolean;
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
  attachments?: NativeConversationAttachmentInput[];
    model?: string;
    effort?: string;
    collaborationMode?: ConversationCollaborationMode;
  idempotencyKey: string;
  clientUserMessageId: string;
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

export interface RestoreArchivedConversationInput {
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
  editQueuedSubmission(input: EditQueuedSubmissionInput): Promise<NativeQueueSnapshot>;
  deleteQueuedSubmission(input: DeleteQueuedSubmissionInput): Promise<NativeQueueSnapshot>;
  reorderQueue(input: ReorderNativeQueueInput): Promise<NativeQueueSnapshot>;
  sendQueuedNow(input: SendQueuedNowInput): Promise<NativeAcceptedOperation>;
  resumeInterruptedQueue(input: ResumeNativeQueueInput): Promise<NativeQueueSnapshot>;

    restoreArchivedConversation(input: RestoreArchivedConversationInput): Promise<NativeQueueSnapshot>;
  interruptTurn(input: InterruptNativeTurnInput): Promise<NativeAcceptedOperation>;
  respondToRequest(input: RespondNativeRequestInput): Promise<NativeAcceptedOperation>;

    snoozeRequest(input: SnoozeNativeRequestInput): Promise<void>;

    respondToPlanImplementationRequest(input: RespondPlanImplementationRequestInput): Promise<NativeAcceptedOperation>;
  recover(): Promise<void>;
  capacityChanged(): Promise<void>;
  close(): Promise<void>;
}
