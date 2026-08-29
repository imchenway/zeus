import type { CodexServerRequestResponse } from '@zeus/ai-runtime';
import type { CodexBootstrapAdditionalContext, TaskPushMessageLayout } from '@zeus/shared';
import type { ConversationCollaborationMode, ConversationPermissionMode, ZeusConversationGoalRecord } from '@zeus/storage';
import type { ConversationSegmentLifecycle } from './conversationExecutionCoordinator.js';

export type NativeConversationRunState =
  | { type: 'idle' }
  | { type: 'dispatching'; submissionId: string }
  | { type: 'active'; turnId: string; phase: 'prework' | 'final_answer' }
  | { type: 'waiting'; turnId: string; requestId: string; reason: 'approval' | 'user_input' }
  | {
      type: 'paused';
      reason:
        | 'interrupted'
        | 'transport_unavailable'
        | 'provider_archived'
        | 'provider_stop_pending'
        | 'interaction_authority_missing'
        | 'recovered_unsent'
        | 'recovery_required'
        | 'runtime_rejected'
        | 'conflict_preparing'
        | 'conflict_preparation_failed';
    };

export interface ConversationDispatchContext {
  projectId: string;
  projectLocalPath: string;
  taskId: string | null;
  executionWorkspaceMode?: 'direct' | 'worktree';
  model: string;
  modelSourceId: string | null;
  effort?: string;
  serviceTier?: string | null;
  allowCodeChanges: boolean;
  allowTests: boolean;
  allowGitCommit: boolean;
  permissionMode: ConversationPermissionMode;
  allowedAttachmentRoots?: string[];
  writableRoots?: string[];
  workMode: ConversationCollaborationMode;
  applyLegacyTaskGuards?: boolean;
  ephemeral?: boolean;
  additionalContext?: CodexBootstrapAdditionalContext;
  operationContext?: Record<string, unknown>;
  holdDispatch?: boolean;
}

export type NativeOperationStatus = 'queued' | 'active' | 'steering' | 'steered' | 'interrupted' | 'responded' | 'provider_archived' | 'recovery_required';

export interface NativeAcceptedOperation {
  operationId: string;
  conversationId: string;
  submissionId: string;
  status: NativeOperationStatus;
  providerThreadId: string | null;
  providerTurnId: string | null;
}

export interface NativeTurnResultWaiter {
  resolve(result: NativeTurnResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
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
  composerDraft?: string;
  status: 'queued' | 'paused';
  delivery: 'queue' | 'steer_now';
  attachments: NativeConversationAttachmentInput[];
  browserComments?: Record<string, unknown>[];
  browserCommentContent?: string;
  conversationContext?: Record<string, unknown>;
  expectedTurnId: string | null;
  clientUserMessageId: string;
  controlAction?: 'implement_plan' | 'refine_plan';
  position: number;
  providerTurnId: null;
  pausedReason: string | null;
  error: NativeSubmissionError | null;
  createdAt: string;
  updatedAt: string;
}

export type NativeQueueWaitReason =
  | 'current_turn'
  | 'dispatching'
  | 'user_input'
  | 'approval'
  | 'plan_confirmation'
  | 'execution_context_preparing'
  | 'interrupted'
  | 'transport_unavailable'
  | 'provider_archived'
  | 'provider_stop_pending'
  | 'interaction_authority_missing'
  | 'recovered_unsent'
  | 'recovery_required'
  | 'runtime_rejected'
  | 'conflict_preparing'
  | 'conflict_preparation_failed'
  | 'user_confirmation'
  | 'dispatch_pending';

export interface NativeQueueSnapshot {
  conversationId: string;
  state: NativeConversationRunState;
  waitReason: NativeQueueWaitReason;
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

export interface NativeConversationSkillInput {
  id: string;
  name: string;
  description: string;
  /** Runtime Adapter 内部使用的绝对 SKILL.md 投影路径。 */
  path: string;
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
  /** 任务会话执行现场的持久语义；直接目录不得因缺少 worktree 记录而被判定为现场丢失。 */
  executionWorkspaceMode?: 'direct' | 'worktree';
  conversationTitle?: string;
  /** 多仓任务只把逐仓 worktree 与显式共享目录授予写权限。 */
  writableRoots?: string[];
  taskTitle: string;
  prompt: string;
  model: string;
  skill?: NativeConversationSkillInput;
  modelSourceId?: string | null;
  effort?: string;
  serviceTier?: string | null;
  requestedServiceTier?: string | null;
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
  /** 会话与首条消息持久接受后立即返回，由后台队列启动 Provider；用于先进入会话再展示准备结果。 */
  deferInitialDispatch?: boolean;
  /** 执行现场尚未就绪时只持久接受消息；释放前所有队列消息都不得派发。 */
  holdDispatch?: boolean;
  /** 已经编码为 app-server v2 线协议的模型上下文。 */
  additionalContext?: CodexBootstrapAdditionalContext;
  /** 由专用业务入口保存的可恢复准备信封，只供 Zeus 使用。 */
  operationContext?: Record<string, unknown>;
  /** 后台追赶分支产生的 Provider turn，不投影成新的用户消息。 */
  internalOperation?: boolean;
  /** Codex composer 的协作模式，仅用于显式任务推送。 */
  workMode?: 'default' | 'plan';
  /** 新推送链路不再读取任务表中的 allow* 兼容字段。 */
  applyLegacyTaskGuards?: boolean;
  legacyReference?: LegacyConversationReference;
  ephemeral?: boolean;
  providerWriteLifecycle?: NativeProviderWriteLifecycle;
  goalObjective?: string;
  segmentLifecycle?: ConversationSegmentLifecycle;
}

export interface StartProjectConversationInput {
  conversationId?: string;
  submissionId?: string;
  projectId: string;
  projectLocalPath: string;
  prompt: string;
  model: string;
  skill?: NativeConversationSkillInput;
  modelSourceId?: string | null;
  effort?: string;
  serviceTier?: string | null;
  requestedServiceTier?: string | null;
  permissionMode?: ConversationPermissionMode;
  collaborationMode?: ConversationCollaborationMode;
  idempotencyKey: string;
  clientUserMessageId: string;
  attachments?: NativeConversationAttachmentInput[];
  providerWriteLifecycle?: NativeProviderWriteLifecycle;
  goalObjective?: string;
  segmentLifecycle?: ConversationSegmentLifecycle;
}

export interface SetNativeGoalInput {
  conversationId: string;
  objective: string;
}

export interface SubmitNativeMessageInput {
  conversationId: string;
  submissionId?: string;
  content: string;
  displayText?: string;
  composerDraft?: string;
  attachments?: NativeConversationAttachmentInput[];
  browserComments?: Record<string, unknown>[];
  browserCommentContent?: string;
  conversationContext?: Record<string, unknown>;
  model?: string;
  modelSourceId?: string | null;
  effort?: string;
  serviceTier?: string | null;
  requestedServiceTier?: string | null;
  permissionMode?: ConversationPermissionMode;
  collaborationMode?: ConversationCollaborationMode;
  idempotencyKey: string;
  clientUserMessageId: string;
  providerWriteLifecycle?: NativeProviderWriteLifecycle;
  segmentLifecycle?: ConversationSegmentLifecycle;
}

export interface DispatchQueuedNativeMessageInput {
  conversationId: string;
  submissionId: string;
  /** 统一执行层根据提交已冻结的路由创建；协调器只复用原提交，不重新生成持久化输入。 */
  segmentLifecycle: ConversationSegmentLifecycle;
}

export interface SteerNativeMessageInput {
  conversationId: string;
  content: string;
  displayText?: string;
  composerDraft?: string;
  attachments?: NativeConversationAttachmentInput[];
  browserComments?: Record<string, unknown>[];
  browserCommentContent?: string;
  conversationContext?: Record<string, unknown>;
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
  /** 公开 Command 的稳定 operationIdentity；用于避免崩溃重入时生成不同 submission。 */
  operationIdentity?: string;
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

export interface RetryQueuedSubmissionInput {
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
  /** 公开父 Command 派生的稳定子资源身份；Graph 问答不得在重连时改号。 */
  conversationId?: string;
  submissionId?: string;
  projectId: string;
  projectLocalPath: string;
  title: string;
  prompt: string;
  model: string;
  skill?: NativeConversationSkillInput;
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

  dispatchQueuedMessage(input: DispatchQueuedNativeMessageInput): Promise<NativeAcceptedOperation>;
  steerMessage(input: SteerNativeMessageInput): Promise<NativeAcceptedOperation>;
  editQueuedSubmission(input: EditQueuedSubmissionInput): Promise<NativeQueueSnapshot>;
  retryQueuedSubmission(input: RetryQueuedSubmissionInput): Promise<NativeQueueSnapshot>;
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
  setGoal(input: SetNativeGoalInput): Promise<ZeusConversationGoalRecord>;
  readGoal(input: { conversationId: string }): Promise<ZeusConversationGoalRecord | null>;
  pauseGoal(input: { conversationId: string }): Promise<ZeusConversationGoalRecord>;
  resumeGoal(input: { conversationId: string }): Promise<ZeusConversationGoalRecord>;
  clearGoal(input: { conversationId: string }): Promise<{ cleared: boolean }>;
  recover(): Promise<void>;
  close(): Promise<void>;
}
