import { nanoid } from 'nanoid';
import {
  ArtifactStore,
  ConversationRepository,
  TaskRepository,
  TaskStageRepository,
  TaskStageStoreError,
  taskStageDeliverableArtifactGeneration,
  type CreateTaskStageInput,
  type UpdateTaskStageInput,
  type ZeusDatabase,
  type ZeusTaskStageDeliverableRecord,
  type ZeusTaskWorkflowSnapshot,
} from '@zeus/storage';

const maximumDeliverableCharacters = 2_000_000;
const maximumDeliverableContentBytes = 16 * 1024 * 1024;

export interface InitializeTaskWorkflowInput {
  templateKey?: string;
  templateRevision?: number;
  stages: CreateTaskStageInput[];
}

export interface CaptureTaskStageDeliverableInput {
  operationIdentity: string;
  title?: string;
  summary?: string;
  kind?: string;
}

export interface CreateManualTaskStageDeliverableInput extends CaptureTaskStageDeliverableInput {
  content: string;
}

interface TaskStageApplicationPorts {
  db: ZeusDatabase;
  tasks: TaskRepository;
  stages: TaskStageRepository;
  conversations: ConversationRepository;
  artifacts: ArtifactStore;
  recordTaskEvent(input: { taskId: string; eventType: string; title: string; payload: Record<string, unknown> }): void;
  publishRealtimeEvent(type: string, payload: Record<string, unknown>): void;
}

/** 任务阶段应用层只编排 Work Management、会话来源和资产引用，不接管 Provider 运行。 */
export class TaskStageApplication {
  constructor(private readonly ports: TaskStageApplicationPorts) {}

  readWorkflow(taskId: string): ZeusTaskWorkflowSnapshot | null {
    this.requireTask(taskId);
    return this.ports.stages.getWorkflowByTask(taskId);
  }

  async initializeWorkflow(taskId: string, input: InitializeTaskWorkflowInput): Promise<ZeusTaskWorkflowSnapshot> {
    this.requireTask(taskId);
    if (!isRecord(input) || !Array.isArray(input.stages)) throw applicationError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', 'stages 必须是阶段数组。', 400);
    const before = this.ports.stages.getWorkflowByTask(taskId);
    const workflow = this.ports.stages.initializeDefault({
      taskId,
      templateKey: input.templateKey,
      templateRevision: input.templateRevision,
      stages: input.stages,
    });
    if (!before) {
      this.ports.recordTaskEvent({
        taskId,
        eventType: 'task.workflow.initialized',
        title: '任务阶段工作流已启用',
        payload: {
          workflowId: workflow.workflow.id,
          templateKey: workflow.workflow.templateKey,
          stages: workflow.stages.map((stage) => ({
            id: stage.id,
            stageKey: stage.stageKey,
            kind: stage.kind,
            agentKind: stage.agentKind,
            modelRef: stage.modelRef,
            effort: stage.effort,
            serviceTier: stage.serviceTier,
            workMode: stage.workMode,
            permissionMode: stage.permissionMode,
            advanceMode: stage.advanceMode,
          })),
        },
      });
      this.publishWorkflowChanged(workflow, 'initialized');
    }
    return workflow;
  }

  async updateStage(taskId: string, stageId: string, input: UpdateTaskStageInput): Promise<ZeusTaskWorkflowSnapshot> {
    if (!isRecord(input)) throw applicationError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', '阶段配置必须是对象。', 400);
    this.requireOwnedStage(taskId, stageId);
    const workflow = this.ports.stages.updateStage(stageId, input);
    const updated = workflow.stages.find((stage) => stage.id === stageId);
    this.ports.recordTaskEvent({
      taskId,
      eventType: 'task.stage.configured',
      title: '任务阶段配置已更新',
      payload: {
        stageId,
        stageRevision: updated?.revision ?? null,
        agentKind: updated?.agentKind ?? null,
        modelRef: updated?.modelRef ?? null,
        effort: updated?.effort ?? null,
        serviceTier: updated?.serviceTier ?? null,
        workMode: updated?.workMode ?? null,
        permissionMode: updated?.permissionMode ?? null,
        advanceMode: updated?.advanceMode ?? null,
      },
    });
    this.publishWorkflowChanged(workflow, 'stage_configured');
    return workflow;
  }

  async captureLatestConversationOutput(taskId: string, stageId: string, input: CaptureTaskStageDeliverableInput): Promise<ZeusTaskWorkflowSnapshot> {
    if (!isRecord(input)) throw applicationError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', '交付物提交参数必须是对象。', 400);
    const stage = this.requireOwnedStage(taskId, stageId);
    const attempt = this.ports.stages.latestAttempt(stage.id);
    if (!attempt?.conversationId) throw applicationError('ZEUS_TASK_STAGE_ATTEMPT_NOT_FOUND', '当前阶段还没有可沉淀的真实会话。', 409);
    const conversation = this.ports.conversations.getById(attempt.conversationId);
    if (!conversation || conversation.taskId !== taskId) throw applicationError('ZEUS_TASK_STAGE_CONVERSATION_CONFLICT', '阶段会话已经不存在或不再属于当前任务。', 409);
    const assistantMessage = [...conversation.messages].reverse().find((message) => message.role === 'assistant' && message.content.trim());
    if (!assistantMessage) throw applicationError('ZEUS_TASK_STAGE_DELIVERABLE_NOT_FOUND', '阶段会话尚未产生可沉淀的助手回复。', 409);
    return this.persistDeliverable({
      taskId,
      stageId,
      attemptId: attempt.id,
      conversationId: conversation.id,
      content: assistantMessage.content,
      operationIdentity: requiredString(input.operationIdentity, 'operationIdentity', 256),
      title: optionalString(input.title, 'title', 240) ?? defaultDeliverableTitle(stage.kind, stage.title),
      summary: optionalString(input.summary, 'summary', 4_000, true) ?? summarizeDeliverable(assistantMessage.content),
      kind: optionalString(input.kind, 'kind', 80) ?? defaultDeliverableKind(stage.kind),
      sourceMessageId: assistantMessage.id,
    });
  }

  async createManualDeliverable(taskId: string, stageId: string, input: CreateManualTaskStageDeliverableInput): Promise<ZeusTaskWorkflowSnapshot> {
    if (!isRecord(input)) throw applicationError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', '交付物提交参数必须是对象。', 400);
    const stage = this.requireOwnedStage(taskId, stageId);
    const attempt = this.ports.stages.latestAttempt(stage.id);
    if (!attempt?.conversationId) throw applicationError('ZEUS_TASK_STAGE_ATTEMPT_NOT_FOUND', '请先启动阶段会话，再提交正式交付物。', 409);
    const content = requiredContent(input.content, 'content', maximumDeliverableCharacters);
    return this.persistDeliverable({
      taskId,
      stageId,
      attemptId: attempt.id,
      conversationId: attempt.conversationId,
      content,
      operationIdentity: requiredString(input.operationIdentity, 'operationIdentity', 256),
      title: optionalString(input.title, 'title', 240) ?? defaultDeliverableTitle(stage.kind, stage.title),
      summary: optionalString(input.summary, 'summary', 4_000, true) ?? summarizeDeliverable(content),
      kind: optionalString(input.kind, 'kind', 80) ?? defaultDeliverableKind(stage.kind),
      sourceMessageId: null,
    });
  }

  async acceptDeliverable(taskId: string, deliverableId: string, input: { expectedStageRevision: number }): Promise<ZeusTaskWorkflowSnapshot> {
    if (!isRecord(input)) throw applicationError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', '验收参数必须是对象。', 400);
    const deliverable = this.requireOwnedDeliverable(taskId, deliverableId);
    const workflow = this.ports.stages.acceptDeliverable(deliverable.id, positiveInteger(input.expectedStageRevision, 'expectedStageRevision'));
    this.ports.recordTaskEvent({
      taskId,
      eventType: 'task.stage.deliverable.accepted',
      title: '阶段交付物已验收',
      payload: { stageId: deliverable.stageId, attemptId: deliverable.attemptId, deliverableId: deliverable.id, version: deliverable.version },
    });
    this.publishWorkflowChanged(workflow, 'deliverable_accepted');
    return workflow;
  }

  async requestChanges(taskId: string, deliverableId: string, input: { expectedStageRevision: number; reason: string }): Promise<ZeusTaskWorkflowSnapshot> {
    if (!isRecord(input)) throw applicationError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', '返工参数必须是对象。', 400);
    const deliverable = this.requireOwnedDeliverable(taskId, deliverableId);
    const reason = requiredString(input.reason, 'reason', 4_000);
    const workflow = this.ports.stages.requestChanges(deliverable.id, {
      expectedStageRevision: positiveInteger(input.expectedStageRevision, 'expectedStageRevision'),
      reason,
    });
    this.ports.recordTaskEvent({
      taskId,
      eventType: 'task.stage.deliverable.changes_requested',
      title: '阶段交付物已要求修改',
      payload: { stageId: deliverable.stageId, attemptId: deliverable.attemptId, deliverableId: deliverable.id, version: deliverable.version, reason },
    });
    this.publishWorkflowChanged(workflow, 'changes_requested');
    return workflow;
  }

  async skipStage(taskId: string, stageId: string, input: { expectedRevision: number; reason: string }): Promise<ZeusTaskWorkflowSnapshot> {
    if (!isRecord(input)) throw applicationError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', '跳过参数必须是对象。', 400);
    this.requireOwnedStage(taskId, stageId);
    const reason = requiredString(input.reason, 'reason', 4_000);
    const workflow = this.ports.stages.skipStage(stageId, positiveInteger(input.expectedRevision, 'expectedRevision'), reason);
    this.ports.recordTaskEvent({
      taskId,
      eventType: 'task.stage.skipped',
      title: '任务阶段已跳过',
      payload: { stageId, reason },
    });
    this.publishWorkflowChanged(workflow, 'stage_skipped');
    return workflow;
  }

  async readDeliverableContent(taskId: string, deliverableId: string): Promise<{ deliverable: ZeusTaskStageDeliverableRecord; content: string }> {
    const deliverable = this.requireOwnedDeliverable(taskId, deliverableId);
    const stored = await this.ports.artifacts.readAuthorized({
      sha256: deliverable.artifactSha256,
      owner: { kind: 'task_stage_deliverable', id: deliverable.id },
      maximumContentBytes: maximumDeliverableContentBytes,
    });
    return { deliverable, content: Buffer.from(stored.bytes).toString('utf8') };
  }

  private async persistDeliverable(input: {
    taskId: string;
    stageId: string;
    attemptId: string;
    conversationId: string;
    content: string;
    operationIdentity: string;
    title: string;
    summary: string;
    kind: string;
    sourceMessageId: string | null;
  }): Promise<ZeusTaskWorkflowSnapshot> {
    const prior = this.ports.stages.getDeliverableByOperation(input.operationIdentity);
    if (prior) {
      if (prior.taskId !== input.taskId || prior.stageId !== input.stageId || prior.attemptId !== input.attemptId) {
        throw applicationError('ZEUS_TASK_STAGE_DELIVERABLE_CONFLICT', '同一操作身份已经提交了另一个阶段交付物。', 409);
      }
      const workflow = this.ports.stages.getWorkflowByTask(input.taskId);
      if (!workflow) throw applicationError('ZEUS_TASK_WORKFLOW_NOT_FOUND', '任务阶段工作流不存在。', 404);
      return workflow;
    }
    const content = requiredContent(input.content, 'content', maximumDeliverableCharacters);
    const task = this.requireTask(input.taskId);
    const deliverableId = `task_stage_deliverable_${nanoid(16)}`;
    const artifactRef = await this.ports.artifacts.putText({
      text: content,
      mimeType: 'text/markdown',
      owner: {
        kind: 'task_stage_deliverable',
        id: deliverableId,
        generationId: taskStageDeliverableArtifactGeneration,
        projectId: task.projectId,
        conversationId: input.conversationId,
      },
    });
    let workflow: ZeusTaskWorkflowSnapshot;
    try {
      this.ports.artifacts.hold({
        sha256: artifactRef.sha256,
        owner: { kind: 'task_stage_deliverable', id: deliverableId },
        ownerClass: 'active_task',
        reason: `task-stage-deliverable:${input.taskId}`,
      });
      workflow = this.ports.stages.createDeliverable({
        taskId: input.taskId,
        stageId: input.stageId,
        attemptId: input.attemptId,
        operationIdentity: input.operationIdentity,
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        artifactRef,
      });
    } catch (error) {
      this.ports.artifacts.releaseOwnerHolds({ owner: { kind: 'task_stage_deliverable', id: deliverableId }, sha256: artifactRef.sha256 });
      this.ports.artifacts.detachOwner({ sha256: artifactRef.sha256, owner: { kind: 'task_stage_deliverable', id: deliverableId } });
      throw error;
    }
    const deliverable = workflow.stages.flatMap((stage) => stage.deliverables).find((candidate) => candidate.id === deliverableId);
    this.ports.recordTaskEvent({
      taskId: input.taskId,
      eventType: deliverable?.status === 'accepted' ? 'task.stage.deliverable.auto_accepted' : 'task.stage.deliverable.submitted',
      title: deliverable?.status === 'accepted' ? '阶段交付物已提交并自动验收' : '阶段交付物已提交，等待验收',
      payload: {
        stageId: input.stageId,
        attemptId: input.attemptId,
        deliverableId,
        version: deliverable?.version ?? null,
        artifactSha256: artifactRef.sha256,
        contentSha256: artifactRef.contentSha256,
        contentByteLength: artifactRef.contentByteLength,
        sourceConversationId: input.conversationId,
        sourceMessageId: input.sourceMessageId,
      },
    });
    this.publishWorkflowChanged(workflow, deliverable?.status === 'accepted' ? 'deliverable_auto_accepted' : 'deliverable_submitted');
    return workflow;
  }

  private requireTask(taskId: string) {
    const task = this.ports.tasks.getById(taskId);
    if (!task) throw applicationError('ZEUS_TASK_NOT_FOUND', 'Task not found', 404);
    return task;
  }

  private requireOwnedStage(taskId: string, stageId: string) {
    this.requireTask(taskId);
    const stage = this.ports.stages.getStage(stageId);
    if (!stage || stage.taskId !== taskId) throw applicationError('ZEUS_TASK_STAGE_NOT_FOUND', '任务阶段不存在。', 404);
    return stage;
  }

  private requireOwnedDeliverable(taskId: string, deliverableId: string): ZeusTaskStageDeliverableRecord {
    this.requireTask(taskId);
    const deliverable = this.ports.stages.getDeliverable(deliverableId);
    if (!deliverable || deliverable.taskId !== taskId) throw applicationError('ZEUS_TASK_STAGE_DELIVERABLE_NOT_FOUND', '阶段交付物不存在。', 404);
    return deliverable;
  }

  private publishWorkflowChanged(workflow: ZeusTaskWorkflowSnapshot, reason: string): void {
    this.ports.db.afterCommit(() =>
      this.ports.publishRealtimeEvent('task.workflow.changed', {
        taskId: workflow.workflow.taskId,
        workflowId: workflow.workflow.id,
        workflowRevision: workflow.workflow.revision,
        currentStageId: workflow.workflow.currentStageId,
        status: workflow.workflow.status,
        reason,
      }),
    );
  }
}

export function taskStageApplicationError(error: unknown): { statusCode: number; body: Record<string, unknown> } {
  if (error instanceof TaskStageStoreError) return { statusCode: error.statusCode, body: { error: error.code, message: error.message, ...error.details } };
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && typeof (error as { statusCode?: unknown }).statusCode === 'number') {
    return { statusCode: (error as { statusCode: number }).statusCode, body: { error: (error as { code: string }).code, message: error instanceof Error ? error.message : 'Task stage operation failed.' } };
  }
  return { statusCode: 500, body: { error: 'ZEUS_TASK_STAGE_OPERATION_FAILED', message: error instanceof Error ? error.message : 'Task stage operation failed.' } };
}

function applicationError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

function defaultDeliverableKind(kind: string): string {
  if (kind === 'plan') return 'plan';
  if (kind === 'implementation') return 'implementation_report';
  if (kind === 'code_review') return 'code_review';
  return 'stage_output';
}

function defaultDeliverableTitle(kind: string, stageTitle: string): string {
  if (kind === 'plan') return '任务实施计划';
  if (kind === 'implementation') return '实施结果';
  if (kind === 'code_review') return '代码审查报告';
  return `${stageTitle}交付物`;
}

function summarizeDeliverable(content: string): string {
  const normalized = content.replace(/\s+/gu, ' ').trim();
  return normalized.length <= 280 ? normalized : `${normalized.slice(0, 277)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) throw applicationError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `${label} 不能为空。`, 400);
  if (value.length > maximum) throw applicationError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `${label} 不能超过 ${maximum} 个字符。`, 400);
  return value.trim();
}

function requiredContent(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) throw applicationError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `${label} 不能为空。`, 400);
  if (value.length > maximum) throw applicationError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `${label} 不能超过 ${maximum} 个字符。`, 400);
  return value;
}

function optionalString(value: unknown, label: string, maximum: number, allowEmpty = false): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw applicationError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `${label} 必须是字符串。`, 400);
  const normalized = value.trim();
  if (!normalized && !allowEmpty) return undefined;
  if (normalized.length > maximum) throw applicationError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `${label} 不能超过 ${maximum} 个字符。`, 400);
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw applicationError('ZEUS_TASK_STAGE_INVALID_ARGUMENT', `${label} 必须是正整数。`, 400);
  return Number(value);
}
