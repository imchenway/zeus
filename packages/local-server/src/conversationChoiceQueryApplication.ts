import type {
  ConversationAttentionKind,
  ConversationRepository,
  ConversationServerRequestRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  ProjectRepository,
  TaskRepository,
  TaskWorkspaceRepository,
  ZeusConversationRecord,
  ZeusTaskWorkspaceRecord,
} from '@zeus/storage';

export type ProjectConversationAttentionState = 'idle' | 'running' | 'unread' | 'completed' | 'failed' | 'interrupted' | 'reply_required';

type ChoiceSubmission = ReturnType<ConversationSubmissionRepository['listRecoverable']>[number];
type ChoiceTurn = ReturnType<ConversationTurnRepository['listInProgress']>[number];

export interface NativeConversationChoiceProjectionContext {
  pendingRequestKindByConversationId: ReadonlyMap<string, 'approval' | 'user_input'>;
  workspaceById: ReadonlyMap<string, ZeusTaskWorkspaceRecord>;
  recoverableSubmissionsByConversationId: ReadonlyMap<string, readonly ChoiceSubmission[]>;
  inProgressTurnsByConversationId: ReadonlyMap<string, readonly ChoiceTurn[]>;
}

interface ConversationChoiceQueryPorts {
  projects: Pick<ProjectRepository, 'list' | 'listArchived' | 'getById'>;
  tasks: Pick<TaskRepository, 'getById' | 'listByProject'>;
  conversations: Pick<ConversationRepository, 'getById' | 'listRecordsByProject' | 'listRecordsByTask' | 'listUnarchivedRecords' | 'meaningfulActivityAt'>;
  requests: Pick<ConversationServerRequestRepository, 'listPending' | 'listPendingByConversation'>;
  submissions: Pick<ConversationSubmissionRepository, 'listRecoverable' | 'getFirstByConversation'>;
  turns: Pick<ConversationTurnRepository, 'listInProgress'>;
  workspaces: Pick<TaskWorkspaceRepository, 'listByProject' | 'getById'>;
  isManagedConversation(conversationId: string): boolean;
  codexNativeEnabled: boolean;
  readOnlyValidation: boolean;
}

/**
 * 会话选择、侧边栏注意力与历史列表是同一只读投影。这里集中拥有投影规则，
 * HTTP、Dashboard 和 Command response 只消费结果，不能分别猜测 Provider 运行态。
 */
export class ConversationChoiceQueryApplication {
  constructor(private readonly ports: ConversationChoiceQueryPorts) {}

  project(projectId: string) {
    return this.ports.projects.getById(projectId);
  }

  task(taskId: string) {
    return this.ports.tasks.getById(taskId);
  }

  buildContext(projectId: string): NativeConversationChoiceProjectionContext {
    const pendingRequestKindByConversationId = new Map<string, 'approval' | 'user_input'>();
    for (const request of this.ports.requests.listPending()) {
      if (!pendingRequestKindByConversationId.has(request.conversationId)) {
        pendingRequestKindByConversationId.set(request.conversationId, request.requestKind === 'request_user_input' ? 'user_input' : 'approval');
      }
    }
    const recoverableSubmissionsByConversationId = new Map<string, ChoiceSubmission[]>();
    for (const submission of this.ports.submissions.listRecoverable()) {
      const entries = recoverableSubmissionsByConversationId.get(submission.conversationId) ?? [];
      entries.push(submission);
      recoverableSubmissionsByConversationId.set(submission.conversationId, entries);
    }
    const inProgressTurnsByConversationId = new Map<string, ChoiceTurn[]>();
    for (const turn of this.ports.turns.listInProgress()) {
      const entries = inProgressTurnsByConversationId.get(turn.conversationId) ?? [];
      entries.push(turn);
      inProgressTurnsByConversationId.set(turn.conversationId, entries);
    }
    return {
      pendingRequestKindByConversationId,
      workspaceById: new Map(this.ports.workspaces.listByProject(projectId).map((workspace) => [workspace.id, workspace])),
      recoverableSubmissionsByConversationId,
      inProgressTurnsByConversationId,
    };
  }

  listProjectChoices(projectId: string) {
    const context = this.buildContext(projectId);
    return this.listProjectHistory(projectId).map((conversation) => this.toChoice(conversation, context));
  }

  listTaskChoices(taskId: string, projectId: string) {
    const context = this.buildContext(projectId);
    return this.toTaskSnapshot(
      taskId,
      projectId,
      this.listTaskHistory(taskId, projectId).map((conversation) => this.toChoice(conversation, context)),
    );
  }

  buildProjectGroups(projectId: string) {
    // 项目侧边栏仍只展示未归档普通会话；任务详情必须同时取得全部归档历史。
    const records = [...this.ports.conversations.listRecordsByProject(projectId), ...this.ports.conversations.listRecordsByProject(projectId, { archived: true })];
    const context = this.buildContext(projectId);
    const projectChoices: ReturnType<ConversationChoiceQueryApplication['toChoice']>[] = [];
    const taskChoices = new Map<string, ReturnType<ConversationChoiceQueryApplication['toChoice']>[]>(this.ports.tasks.listByProject(projectId).map((task) => [task.id, []]));
    for (const conversation of records) {
      if (conversation.taskId === null) {
        if (this.isVisibleProjectConversation(conversation)) projectChoices.push(this.toChoice(conversation, context));
        continue;
      }
      if (!this.isMeaningfulTaskHistoryItem(conversation)) continue;
      const choices = taskChoices.get(conversation.taskId) ?? [];
      choices.push(this.toChoice(conversation, context));
      taskChoices.set(conversation.taskId, choices);
    }
    const sortedProjectChoices = projectChoices.sort(compareConversationStageUpdatedDesc);
    return {
      projectId,
      projectChoices: { projectId, choices: sortedProjectChoices, items: sortedProjectChoices },
      taskChoicesByTaskId: Object.fromEntries([...taskChoices].map(([taskId, choices]) => [taskId, this.toTaskSnapshot(taskId, projectId, choices)])),
    };
  }

  listArchivedChoices() {
    const history: ZeusConversationRecord[] = [];
    for (const project of [...this.ports.projects.list(), ...this.ports.projects.listArchived()]) {
      history.push(
        ...this.ports.conversations.listRecordsByProject(project.id, { archived: true }).filter((conversation) => (conversation.taskId !== null ? this.isMeaningfulTaskHistoryItem(conversation) : this.isProjectHistoryItem(conversation))),
      );
    }
    return history.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map((conversation) => this.toChoice(conversation, this.buildContext(conversation.projectId)));
  }

  toChoice(conversation: ZeusConversationRecord, context: NativeConversationChoiceProjectionContext = this.buildContext(conversation.projectId)) {
    const state = this.projectState(conversation, context);
    const managedByTaskWorkItem = this.ports.isManagedConversation(conversation.id);
    return {
      ...this.toSummary(conversation, context),
      listRuntimeState: state.runtimeState,
      taskRunStatus: state.taskRunStatus,
      // 正式数据库副本中的原生会话只允许历史投影；列表本身就必须显式禁用恢复。
      resumable: !managedByTaskWorkItem && !this.ports.readOnlyValidation && conversation.transportKind === 'codex_native' && !conversation.archived && conversation.providerState !== 'closed' && conversation.providerState !== 'failed',
      readOnly: managedByTaskWorkItem || this.ports.readOnlyValidation || conversation.transportKind === 'legacy_cli',
      managedByTaskWorkItem,
    };
  }

  attentionByProject(projectIds: readonly string[]): Record<string, ProjectConversationAttentionState> {
    const targetProjectIds = new Set(projectIds);
    const states = new Map<string, ProjectConversationAttentionState>(projectIds.map((projectId) => [projectId, 'idle']));
    const pendingRequestConversationIds = new Set(this.ports.requests.listPending().map((request) => request.conversationId));
    const runningSubmissionConversationIds = new Set(
      this.ports.submissions
        .listRecoverable()
        .filter((submission) => submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active')
        .map((submission) => submission.conversationId),
    );
    for (const conversation of this.ports.conversations.listUnarchivedRecords()) {
      if (!targetProjectIds.has(conversation.projectId) || this.isEphemeral(conversation)) continue;
      const replyRequired = pendingRequestConversationIds.has(conversation.id) || conversation.providerState === 'waiting';
      const legacyRuntimeRunning = conversation.transportKind === 'legacy_cli' && (conversation.status === 'starting' || conversation.status === 'running');
      const running = runningSubmissionConversationIds.has(conversation.id) || conversation.providerState === 'binding' || conversation.providerState === 'active' || legacyRuntimeRunning;
      if (replyRequired) {
        states.set(conversation.projectId, 'reply_required');
      } else if (states.get(conversation.projectId) !== 'reply_required' && conversation.attentionUnread) {
        const attentionState = toAttentionState(conversation.attentionKind);
        if (attentionPriority(attentionState) > attentionPriority(states.get(conversation.projectId) ?? 'idle')) states.set(conversation.projectId, attentionState);
      } else if (running && states.get(conversation.projectId) === 'idle') {
        states.set(conversation.projectId, 'running');
      }
    }
    return Object.fromEntries(states);
  }

  unreadCountByProject(projectIds: readonly string[]): Record<string, number> {
    const targetProjectIds = new Set(projectIds);
    const counts = new Map<string, number>(projectIds.map((projectId) => [projectId, 0]));
    for (const conversation of this.ports.conversations.listUnarchivedRecords()) {
      if (!targetProjectIds.has(conversation.projectId) || !conversation.attentionUnread || this.isEphemeral(conversation)) continue;
      counts.set(conversation.projectId, (counts.get(conversation.projectId) ?? 0) + 1);
    }
    return Object.fromEntries(counts);
  }

  listTaskHistory(taskId: string, projectId: string): ZeusConversationRecord[] {
    return [...this.ports.conversations.listRecordsByTask(taskId), ...this.ports.conversations.listRecordsByTask(taskId, { archived: true })]
      .filter((conversation) => conversation.projectId === projectId && this.isMeaningfulTaskHistoryItem(conversation))
      .sort(compareConversationStageUpdatedDesc);
  }

  private listProjectHistory(projectId: string): ZeusConversationRecord[] {
    return this.ports.conversations
      .listRecordsByProject(projectId)
      .filter((conversation) => this.isVisibleProjectConversation(conversation))
      .sort(compareConversationStageUpdatedDesc);
  }

  private isVisibleProjectConversation(conversation: ZeusConversationRecord): boolean {
    return !conversation.archived && this.isProjectHistoryItem(conversation);
  }

  private isProjectHistoryItem(conversation: ZeusConversationRecord): boolean {
    return conversation.taskId !== null || !this.isEphemeral(conversation);
  }

  /**
   * 用户主动归档的会话必须始终保留恢复入口，即使它在首次外发前取消了提交。
   * 只有未归档、Provider 从未绑定且首次提交已被取消/删除的原生壳才不进入任务历史。
   */
  private isMeaningfulTaskHistoryItem(conversation: ZeusConversationRecord): boolean {
    if (conversation.archived) return true;
    if (conversation.transportKind !== 'codex_native' || conversation.providerThreadId?.trim()) return true;
    const firstSubmission = this.ports.submissions.getFirstByConversation(conversation.id);
    const hasMessages = (this.ports.conversations.getById(conversation.id)?.messages.length ?? 0) > 0;
    return hasMessages || Boolean(firstSubmission && firstSubmission.status !== 'cancelled' && firstSubmission.status !== 'deleted');
  }

  private isEphemeral(conversation: Pick<ZeusConversationRecord, 'id'>): boolean {
    const firstSubmission = this.ports.submissions.getFirstByConversation(conversation.id);
    const context = firstSubmission ? parseJsonObject(firstSubmission.inputJson).context : undefined;
    return isRecord(context) && context.ephemeral === true;
  }

  private toTaskSnapshot(taskId: string, projectId: string, choices: ReturnType<ConversationChoiceQueryApplication['toChoice']>[]) {
    const sortedChoices = [...choices].sort(compareConversationStageUpdatedDesc);
    return { taskId, projectId, hasHistory: sortedChoices.length > 0, requiresChoice: sortedChoices.length > 0, choices: sortedChoices, items: sortedChoices };
  }

  toSummary(conversation: ZeusConversationRecord, context: NativeConversationChoiceProjectionContext = this.buildContext(conversation.projectId)) {
    const pendingRequestKind = context.pendingRequestKindByConversationId.get(conversation.id) ?? null;
    return {
      id: conversation.id,
      projectId: conversation.projectId,
      taskId: conversation.taskId,
      workspaceId: conversation.workspaceId,
      environmentId: conversation.environmentId,
      workspace: conversation.workspaceId ? (context.workspaceById.get(conversation.workspaceId) ?? this.ports.workspaces.getById(conversation.workspaceId) ?? null) : null,
      title: conversation.title,
      summary: conversation.summary,
      status: conversation.status,
      stage: conversation.stage,
      stageUpdatedAt: conversation.stageUpdatedAt,
      transportKind: conversation.transportKind,
      providerId: conversation.providerId,
      providerThreadId: conversation.providerThreadId,
      providerModel: conversation.providerModel,
      providerState: conversation.providerState,
      legacySourceConversationId: conversation.legacySourceConversationId,
      permissionMode: conversation.permissionMode,
      collaborationMode: conversation.collaborationMode,
      hasUnreadAttention: conversation.attentionUnread,
      attentionKind: conversation.attentionKind,
      attentionRevision: conversation.attentionRevision,
      attentionTurnId: conversation.attentionTurnId,
      attentionUpdatedAt: conversation.attentionUpdatedAt,
      pendingRequestKind,
      provider: { id: conversation.providerId, threadId: conversation.providerThreadId, model: conversation.providerModel, state: conversation.providerState },
      agent: {
        kind: conversation.agentKind,
        transport: conversation.agentTransport,
        supportStatus: conversation.agentKind === 'codex' && this.ports.codexNativeEnabled ? 'verified' : conversation.agentKind === 'pi' ? 'experimental' : 'unavailable',
        capabilitySnapshotId: conversation.capabilitySnapshotId,
      },
      model: { sourceId: conversation.modelSourceId, id: conversation.modelId ?? conversation.providerModel },
      nativeSession: { id: conversation.nativeSessionId ?? conversation.providerThreadId, path: conversation.nativeSessionPath ?? conversation.providerThreadPath },
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      activityAt: this.ports.conversations.meaningfulActivityAt(conversation.id),
      archived: conversation.archived,
    };
  }

  private projectState(conversation: ZeusConversationRecord, context: NativeConversationChoiceProjectionContext) {
    if (conversation.transportKind !== 'codex_native') return { runtimeState: 'legacy_readonly' as const, taskRunStatus: 'legacy_readonly' as const };
    const providerState = `${conversation.providerState ?? ''}`.toLowerCase();
    const recordState = conversation.status.toLowerCase();
    if (providerState.includes('failed') || providerState.includes('error') || recordState.includes('failed') || recordState.includes('error')) return { runtimeState: 'error' as const, taskRunStatus: 'failed' as const };
    const submissions = context.recoverableSubmissionsByConversationId.get(conversation.id) ?? [];
    const pendingRequestKind = context.pendingRequestKindByConversationId.get(conversation.id);
    if (providerState === 'archived') {
      const queued = submissions.some((submission) => (submission.status === 'queued' || submission.status === 'paused') && !submission.providerTurnId);
      return queued ? { runtimeState: 'queued' as const, taskRunStatus: 'running' as const } : { runtimeState: 'ready' as const, taskRunStatus: 'idle' as const };
    }
    // `conversation_plan_actions` 与普通 server request 使用不同的持久表，但都会同步
    // 到同一个权威会话阶段。列表只消费该持久投影，避免为计划确认再增加一套接口字段。
    if (conversation.stage === 'waiting_user') return { runtimeState: 'pending_user_input' as const, taskRunStatus: 'waiting_user' as const };
    if (conversation.stage === 'waiting_approval') return { runtimeState: 'pending_approval' as const, taskRunStatus: 'waiting_approval' as const };
    const activeTurn = [...(context.inProgressTurnsByConversationId.get(conversation.id) ?? [])].reverse().find((turn) => (turn.status === 'running' || turn.status === 'dispatching' || turn.status === 'waiting') && turn.providerTurnId);
    if (activeTurn) {
      if (activeTurn.status === 'waiting' && pendingRequestKind === 'user_input') return { runtimeState: 'pending_user_input' as const, taskRunStatus: 'waiting_user' as const };
      if (activeTurn.status === 'waiting' && pendingRequestKind === 'approval') return { runtimeState: 'pending_approval' as const, taskRunStatus: 'waiting_approval' as const };
      return { runtimeState: 'streaming' as const, taskRunStatus: 'running' as const };
    }
    const paused = submissions.filter((submission) => submission.status === 'paused');
    if (paused.some((submission) => submission.pausedReason === 'recovery_required') || providerState === 'paused') return { runtimeState: 'paused' as const, taskRunStatus: 'paused' as const };
    if (paused.length > 0 && !paused.every((submission) => submission.pausedReason === 'user_confirmation')) return { runtimeState: 'paused' as const, taskRunStatus: 'paused' as const };
    if (pendingRequestKind === 'user_input') return { runtimeState: 'pending_user_input' as const, taskRunStatus: 'waiting_user' as const };
    if (pendingRequestKind === 'approval') return { runtimeState: 'pending_approval' as const, taskRunStatus: 'waiting_approval' as const };
    if (submissions.some((submission) => submission.status === 'dispatching' || submission.status === 'active')) return { runtimeState: 'streaming' as const, taskRunStatus: 'running' as const };
    if (submissions.some((submission) => submission.status === 'queued')) return { runtimeState: 'queued' as const, taskRunStatus: 'running' as const };
    return { runtimeState: 'ready' as const, taskRunStatus: 'idle' as const };
  }
}

export function compareConversationStageUpdatedDesc(left: Pick<ZeusConversationRecord, 'id' | 'stageUpdatedAt' | 'createdAt'>, right: Pick<ZeusConversationRecord, 'id' | 'stageUpdatedAt' | 'createdAt'>): number {
  return right.stageUpdatedAt.localeCompare(left.stageUpdatedAt) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function toAttentionState(kind: ConversationAttentionKind): ProjectConversationAttentionState {
  return kind === 'none' ? 'unread' : kind;
}

function attentionPriority(state: ProjectConversationAttentionState): number {
  if (state === 'reply_required') return 6;
  if (state === 'failed' || state === 'interrupted') return 5;
  if (state === 'completed') return 4;
  if (state === 'unread') return 3;
  if (state === 'running') return 2;
  return 1;
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
