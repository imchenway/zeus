import {getNextTaskStatus, type TaskStatus} from './taskCore.js';
import {
    isTaskBoardGroupProperty,
    taskBoardEmptyGroupId,
    type TaskBoardGroupProperty,
    taskBoardLayoutKey,
    type TaskBoardMoveRequest,
    type TaskBoardViewSnapshot,
    type TaskManagementStatusConfig
} from '@zeus/shared';
import {
    isTaskPriority,
    isTaskType,
    TaskBoardRepository,
    type TaskManagementStatus,
    type TaskPriority,
    TaskRepository,
    type ZeusProjectRecord,
    type ZeusTaskRecord
} from '@zeus/storage';
import {WorkManagementRouteError} from './workManagementCoreCommandRoutes.js';
import {normalizeWorkManagementTaskAttachments} from './workManagementTaskInput.js';
import {
    type DeleteTaskCommandInput,
    type PreparedConditionalTaskOperation,
    type PreparedTaskOperation,
    type TaskRuntimeCommandAction,
    type UpdateTaskContentCommandInput,
    type UpdateTaskManagementStatusCommandInput,
    type UpdateTaskRelationshipsCommandInput,
    type UpdateTaskStatusCommandInput,
    type UpdateTaskTagsCommandInput,
    type WorkManagementTaskCommandContext,
} from './workManagementTaskCommandRoutes.js';

export interface ReopenableTaskConversation {
  id: string;
  projectId: string;
  taskId: string | null;
  archived: boolean;
}

interface WorkManagementTaskAuditInput {
  actorType: WorkManagementTaskCommandContext['actor']['kind'];
  actorRef?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  payload: Record<string, unknown>;
}

export interface TaskStatusMutationPlan {
  taskId: string;
  requestedStatus: TaskStatus;
}

export interface TaskManagementStatusPlan<TCleanup, TConversation extends ReopenableTaskConversation> {
  taskId: string;
  projectId: string;
  expectedUpdatedAt: string;
  fromStatus: TaskManagementStatus;
  targetStatus: TaskManagementStatus;
  cleanup: TCleanup | null;
  reopenTarget: TConversation | null;
}

export interface TaskManagementStatusEffect<TConversation extends ReopenableTaskConversation> {
  restoredConversation: TConversation | null;
}

interface TaskBoardPropertyMutation {
  property: TaskBoardGroupProperty;
  sourceId: string;
  targetId: string;
}

export interface TaskBoardMovePlan<TCleanup, TConversation extends ReopenableTaskConversation> {
  projectId: string;
  taskId: string;
  input: TaskBoardMoveRequest;
  layoutKey: string;
  sourceSubgroupId: string;
  targetSubgroupId: string;
  groupBy: TaskBoardGroupProperty;
  subgroupBy: TaskBoardGroupProperty | null;
  mutations: TaskBoardPropertyMutation[];
  targetLaneTaskIds: string[];
  insertionIndex: number;
  removeTagOccurrenceOnly: boolean;
  managementStatusPlan: TaskManagementStatusPlan<TCleanup, TConversation> | null;
}

export interface TaskRuntimeActionPlan {
  action: TaskRuntimeCommandAction;
  taskId: string;
  project: ZeusProjectRecord;
  initialStatus: TaskStatus;
}

/** 纯领域事实只在 WorkManagementCommandApplication 持有的同步事务中调用。 */
export class WorkManagementTaskOperations<TCleanup, TConversation extends ReopenableTaskConversation, TRuntimeEffect, TRuntimeResult> {
  constructor(
    private readonly options: {
      projects: { getById(projectId: string): ZeusProjectRecord | undefined };
      tasks: TaskRepository;
      taskBoards: TaskBoardRepository;
      resolveManagementStatusConfig(projectId: string): TaskManagementStatusConfig;
      isConfiguredManagementStatus(projectId: string, value: unknown): value is TaskManagementStatus;
      isManagementStatusTerminal(task: ZeusTaskRecord): boolean;
      taskBoardGroupValues(task: ZeusTaskRecord, property: TaskBoardGroupProperty): string[];
      inspectTerminalCleanup(taskId: string, projectLocalPath: string): Promise<TCleanup>;
      cleanupRequiresConfirmation(cleanup: TCleanup): { required: boolean; dirtyWorkspaceCount: number; activeConversationCount: number; activeRuntimeSessionCount: number };
      closeTerminalResources(taskId: string, cleanup: TCleanup): Promise<void>;
      listTaskConversationHistory(taskId: string, projectId: string): TConversation[];
      restoreTaskConversation(conversation: TConversation): Promise<TConversation | null>;
      validateRuntimeAction(action: TaskRuntimeCommandAction, task: ZeusTaskRecord, project: ZeusProjectRecord): void;
      invokeRuntimeAction(action: Extract<TaskRuntimeCommandAction, 'run' | 'continue'>, task: ZeusTaskRecord, project: ZeusProjectRecord, operationIdentity: string): Promise<TRuntimeEffect>;
      stopRuntimeSessions(taskId: string): Promise<TRuntimeEffect>;
      finalizeStartedRuntimeAction(action: Extract<TaskRuntimeCommandAction, 'run' | 'continue'>, task: ZeusTaskRecord, effect: TRuntimeEffect, context: WorkManagementTaskCommandContext): TRuntimeResult;
      recordTaskEvent(input: { taskId: string; eventType: string; title: string; payload: Record<string, unknown> }): void;
      appendAuditLog(input: WorkManagementTaskAuditInput): void;
      afterCommit(callback: () => void | Promise<void>): void;
      publishRealtimeEvent(type: string, payload: Record<string, unknown>): void;
      taskStatusEventTitle(status: TaskStatus): string;
      shouldEnqueueTelegram(status: TaskStatus): boolean;
      scheduleGraphCompletion(task: ZeusTaskRecord): void | Promise<void>;
    },
  ) {}

  prepareStatus(taskId: string, input: UpdateTaskStatusCommandInput): TaskStatusMutationPlan {
    assertExactKeys(input, ['status'], 'Task status input');
    const task = this.requireTask(taskId);
    getNextTaskStatus(task.status, input.status);
    return { taskId, requestedStatus: input.status };
  }

  mutateStatus(plan: TaskStatusMutationPlan, context: WorkManagementTaskCommandContext): { result: ZeusTaskRecord; telegramStatus?: string } {
    const existing = this.requireTask(plan.taskId);
    const nextStatus = getNextTaskStatus(existing.status, plan.requestedStatus);
    const updated = this.options.tasks.updateStatus(existing.id, nextStatus);
    this.recordStatusChanged(existing, updated, 'task.status.patch', context);
    this.options.afterCommit(() => {
      this.options.publishRealtimeEvent('task.status.changed', statusRealtimePayload(updated, existing.status, nextStatus, 'task.status.patch'));
      if (nextStatus === 'completed') return this.options.scheduleGraphCompletion(updated);
    });
    return {
      result: updated,
      ...(this.options.shouldEnqueueTelegram(nextStatus) ? { telegramStatus: nextStatus } : {}),
    };
  }

  async prepareManagementStatus(taskId: string, input: UpdateTaskManagementStatusCommandInput): Promise<PreparedConditionalTaskOperation<TaskManagementStatusPlan<TCleanup, TConversation>>> {
    assertExactKeys(input, ['confirmWorktreeCleanup', 'expectedUpdatedAt', 'reopenConversationId', 'status'], 'Task management status input', true);
    if (!this.options.isConfiguredManagementStatus(this.requireTask(taskId).projectId, input.status)) {
      throw routeError(400, 'ZEUS_INVALID_TASK_MANAGEMENT_STATUS', 'Unknown task management status');
    }
    if (typeof input.expectedUpdatedAt !== 'string' || !input.expectedUpdatedAt || input.expectedUpdatedAt.length > 128) {
      throw routeError(400, 'ZEUS_TASK_EDIT_VERSION_REQUIRED', 'expectedUpdatedAt is required when updating task management status.');
    }
    if (input.confirmWorktreeCleanup !== undefined && typeof input.confirmWorktreeCleanup !== 'boolean') {
      throw routeError(400, 'ZEUS_INVALID_TASK_WORKTREE_CLEANUP_CONFIRMATION', 'confirmWorktreeCleanup must be a boolean when provided.');
    }
    if (input.reopenConversationId !== undefined && (typeof input.reopenConversationId !== 'string' || !input.reopenConversationId.trim() || input.reopenConversationId.length > 256)) {
      throw routeError(400, 'ZEUS_INVALID_TASK_REOPEN_CONVERSATION', 'reopenConversationId must be a non-empty bounded string when provided.');
    }
    const existing = this.requireTask(taskId);
    if (existing.updatedAt !== input.expectedUpdatedAt) throw editConflict(existing);
    const statusConfig = this.options.resolveManagementStatusConfig(existing.projectId);
    const targetStatus = input.status as TaskManagementStatus;
    if (targetStatus === existing.managementStatus) {
      return {
        resourceId: existing.id,
        requiresExternal: false,
        state: {
          taskId: existing.id,
          projectId: existing.projectId,
          expectedUpdatedAt: existing.updatedAt,
          fromStatus: existing.managementStatus,
          targetStatus,
          cleanup: null,
          reopenTarget: null,
        },
      };
    }
    const targetIsTerminal = targetStatus === statusConfig.roles.completedStatusId || targetStatus === statusConfig.roles.cancelledStatusId;
    let cleanup: TCleanup | null = null;
    if (targetIsTerminal) {
      const project = this.requireProject(existing.projectId);
      cleanup = await this.options.inspectTerminalCleanup(existing.id, project.localPath);
      const confirmation = this.options.cleanupRequiresConfirmation(cleanup);
      if (confirmation.required && input.confirmWorktreeCleanup !== true) {
        throw new WorkManagementRouteError(409, {
          error: 'ZEUS_TASK_WORKTREE_CLEANUP_CONFIRMATION_REQUIRED',
          message: 'Task worktrees contain local changes or active sessions. Confirm to stop and archive task sessions and permanently remove the worktrees.',
          targetStatus,
          dirtyWorkspaceCount: confirmation.dirtyWorkspaceCount,
          activeConversationCount: confirmation.activeConversationCount,
          activeRuntimeSessionCount: confirmation.activeRuntimeSessionCount,
        });
      }
    }
    let reopenTarget: TConversation | null = null;
    if (this.options.isManagementStatusTerminal(existing) && !targetIsTerminal) {
      const history = this.options.listTaskConversationHistory(existing.id, existing.projectId);
      const requestedId = input.reopenConversationId?.trim();
      // 状态变更本身不代表用户选择了某条历史会话；只有显式指定才恢复精确会话。
      reopenTarget = requestedId ? (history.find((conversation) => conversation.id === requestedId) ?? null) : null;
      if (requestedId && !reopenTarget) throw routeError(409, 'ZEUS_TASK_REOPEN_CONVERSATION_NOT_FOUND', 'The selected conversation does not belong to this task.');
    }
    const state = {
      taskId: existing.id,
      projectId: existing.projectId,
      expectedUpdatedAt: existing.updatedAt,
      fromStatus: existing.managementStatus,
      targetStatus,
      cleanup,
      reopenTarget,
    };
    return { resourceId: existing.id, requiresExternal: cleanup !== null || Boolean(reopenTarget?.archived), state };
  }

  async invokeManagementStatus(plan: TaskManagementStatusPlan<TCleanup, TConversation>): Promise<TaskManagementStatusEffect<TConversation>> {
    if (plan.cleanup !== null) await this.options.closeTerminalResources(plan.taskId, plan.cleanup);
    const restoredConversation = plan.reopenTarget?.archived ? await this.options.restoreTaskConversation(plan.reopenTarget) : null;
    return { restoredConversation };
  }

  mutateManagementStatus(plan: TaskManagementStatusPlan<TCleanup, TConversation>, effect: TaskManagementStatusEffect<TConversation> | null, context: WorkManagementTaskCommandContext): ZeusTaskRecord {
    const existing = this.requireTask(plan.taskId);
    if (existing.updatedAt !== plan.expectedUpdatedAt || existing.managementStatus !== plan.fromStatus) throw editConflict(existing);
    const updated = this.options.tasks.updateManagementStatus(existing.id, plan.targetStatus, plan.expectedUpdatedAt);
    if (updated.managementStatus !== existing.managementStatus) {
      this.options.recordTaskEvent({
        taskId: updated.id,
        eventType: 'task.management_status.changed',
        title: '任务管理状态已变更',
        payload: { from: existing.managementStatus, to: updated.managementStatus, commandId: context.commandId },
      });
      this.options.appendAuditLog({
        actorType: context.actor.kind,
        ...(context.actor.id ? { actorRef: context.actor.id } : {}),
        action: 'task.management_status.changed',
        resourceType: 'task',
        resourceId: updated.id,
        payload: { taskId: updated.id, projectId: updated.projectId, from: existing.managementStatus, to: updated.managementStatus, commandId: context.commandId },
      });
    }
    if (effect?.restoredConversation) {
      this.options.appendAuditLog({
        actorType: context.actor.kind,
        ...(context.actor.id ? { actorRef: context.actor.id } : {}),
        action: 'conversation.restored',
        resourceType: 'conversation',
        resourceId: effect.restoredConversation.id,
        payload: { projectId: effect.restoredConversation.projectId, taskId: updated.id, conversationId: effect.restoredConversation.id, reason: 'task_reopened', commandId: context.commandId },
      });
    }
    if (updated.managementStatus !== existing.managementStatus) {
      this.options.afterCommit(() =>
        this.options.publishRealtimeEvent('task.updated', {
          taskId: updated.id,
          projectId: updated.projectId,
          managementStatus: updated.managementStatus,
          changedFields: ['managementStatus'],
          updatedAt: updated.updatedAt,
        }),
      );
    }
    return updated;
  }

  async prepareTaskBoardMove(projectId: string, input: TaskBoardMoveRequest): Promise<PreparedConditionalTaskOperation<TaskBoardMovePlan<TCleanup, TConversation>>> {
    validateBoardMoveInput(input);
    const project = this.requireProject(projectId);
    const existing = this.requireTask(input.taskId);
    if (existing.projectId !== project.id) throw routeError(404, 'ZEUS_TASK_NOT_FOUND', 'Task not found');
    if (existing.updatedAt !== input.expectedTaskUpdatedAt) throw editConflict(existing, 'Task changed after dragging started.');
    const board = this.options.taskBoards.getSnapshot(project.id);
    if (board.revision !== input.expectedViewRevision) throw boardRevisionConflict(board, 'Task board changed after dragging started.');
    const groupBy = board.settings.groupBy;
    const subgroupBy = board.settings.subgroupBy;
    if (!isTaskBoardGroupProperty(groupBy) || (subgroupBy !== null && !isTaskBoardGroupProperty(subgroupBy))) {
      throw new WorkManagementRouteError(409, { error: 'ZEUS_TASK_BOARD_SETTINGS_INVALID', message: 'Task board grouping is invalid.', board });
    }
    const sourceSubgroupId = subgroupBy ? (input.source.subgroupId ?? taskBoardEmptyGroupId) : '';
    const targetSubgroupId = subgroupBy ? (input.target.subgroupId ?? taskBoardEmptyGroupId) : '';
    if (!this.taskBelongsToLane(existing, groupBy, subgroupBy, input.source.groupId, sourceSubgroupId)) {
      throw new WorkManagementRouteError(409, { error: 'ZEUS_TASK_BOARD_SOURCE_CHANGED', message: 'Task is no longer in the dragged lane.', task: existing, board });
    }
    const sameLane = input.source.groupId === input.target.groupId && sourceSubgroupId === targetSubgroupId;
    if (sameLane && board.settings.sorts.length > 0) {
      throw new WorkManagementRouteError(409, { error: 'ZEUS_TASK_BOARD_SORT_ACTIVE', message: '当前看板使用属性排序；请清除排序后再调整列内手工顺序。', board });
    }
    const layoutKey = taskBoardLayoutKey(board.settings);
    const rankByTaskId = new Map(
      board.positions.filter((position) => position.layoutKey === layoutKey && position.groupId === input.target.groupId && position.subgroupId === targetSubgroupId).map((position) => [position.taskId, position.rank]),
    );
    const targetLaneTaskIds = this.options.tasks
      .listByProject(project.id)
      .filter((task) => task.id !== existing.id && this.taskBelongsToLane(task, groupBy, subgroupBy, input.target.groupId, targetSubgroupId))
      .sort((left, right) => compareBoardTasks(left, right, rankByTaskId))
      .map((task) => task.id);
    const insertionIndex = resolveBoardInsertionIndex(input, targetLaneTaskIds, existing, board);
    const mutations: TaskBoardPropertyMutation[] = [
      { property: groupBy, sourceId: input.source.groupId, targetId: input.target.groupId },
      ...(subgroupBy ? [{ property: subgroupBy, sourceId: sourceSubgroupId, targetId: targetSubgroupId }] : []),
    ].sort((left, right) => Number(right.property === 'managementStatus') - Number(left.property === 'managementStatus'));
    for (const mutation of mutations) this.validateBoardPropertyMutation(existing, mutation);
    const managementMutation = mutations.find((mutation) => mutation.property === 'managementStatus' && mutation.sourceId !== mutation.targetId);
    const managementStatusPlan = managementMutation
      ? (
          await this.prepareManagementStatus(existing.id, {
            status: managementMutation.targetId,
            expectedUpdatedAt: existing.updatedAt,
            ...(input.confirmWorktreeCleanup === true ? { confirmWorktreeCleanup: true } : {}),
          })
        ).state
      : null;
    const removeTagOccurrenceOnly = existing.tags.length > 0 && ((groupBy === 'tags' && input.target.groupId === taskBoardEmptyGroupId) || (subgroupBy === 'tags' && targetSubgroupId === taskBoardEmptyGroupId));
    return {
      resourceId: existing.id,
      requiresExternal: managementStatusPlan !== null && (managementStatusPlan.cleanup !== null || Boolean(managementStatusPlan.reopenTarget?.archived)),
      state: {
        projectId: project.id,
        taskId: existing.id,
        input,
        layoutKey,
        sourceSubgroupId,
        targetSubgroupId,
        groupBy,
        subgroupBy,
        mutations,
        targetLaneTaskIds,
        insertionIndex,
        removeTagOccurrenceOnly,
        managementStatusPlan,
      },
    };
  }

  invokeTaskBoardMove(plan: TaskBoardMovePlan<TCleanup, TConversation>): Promise<TaskManagementStatusEffect<TConversation>> {
    return plan.managementStatusPlan ? this.invokeManagementStatus(plan.managementStatusPlan) : Promise.resolve({ restoredConversation: null });
  }

  mutateTaskBoardMove(plan: TaskBoardMovePlan<TCleanup, TConversation>, effect: TaskManagementStatusEffect<TConversation> | null, context: WorkManagementTaskCommandContext): { task: ZeusTaskRecord; board: TaskBoardViewSnapshot } {
    const current = this.requireTask(plan.taskId);
    if (current.updatedAt !== plan.input.expectedTaskUpdatedAt) throw editConflict(current, 'Task changed while it was being moved.');
    const currentBoard = this.options.taskBoards.getSnapshot(plan.projectId);
    if (currentBoard.revision !== plan.input.expectedViewRevision) throw boardRevisionConflict(currentBoard, 'Task board changed while the task was being moved.');
    if (!this.taskBelongsToLane(current, plan.groupBy, plan.subgroupBy, plan.input.source.groupId, plan.sourceSubgroupId)) {
      throw new WorkManagementRouteError(409, { error: 'ZEUS_TASK_BOARD_SOURCE_CHANGED', message: 'Task is no longer in the dragged lane.', task: current, board: currentBoard });
    }
    let updated = current;
    for (const mutation of plan.mutations) {
      if (mutation.sourceId === mutation.targetId) continue;
      if (mutation.property === 'managementStatus') {
        if (!plan.managementStatusPlan) throw new Error('Task board management status plan is missing.');
        updated = this.mutateManagementStatus({ ...plan.managementStatusPlan, expectedUpdatedAt: updated.updatedAt, fromStatus: updated.managementStatus }, effect, context);
      } else if (mutation.property === 'priority') {
        updated = this.options.tasks.updateContent(updated.id, { expectedUpdatedAt: updated.updatedAt, priority: mutation.targetId as TaskPriority }).task;
      } else if (mutation.property === 'taskType') {
        updated = this.options.tasks.updateContent(updated.id, { expectedUpdatedAt: updated.updatedAt, taskType: mutation.targetId as ZeusTaskRecord['taskType'] }).task;
      } else if (mutation.property === 'tags') {
        const tags = updated.tags.filter((tag) => mutation.sourceId === taskBoardEmptyGroupId || tag !== mutation.sourceId);
        if (mutation.targetId !== taskBoardEmptyGroupId && !tags.includes(mutation.targetId)) tags.push(mutation.targetId);
        updated = this.options.tasks.updateContent(updated.id, { expectedUpdatedAt: updated.updatedAt, tags }).task;
      } else if (mutation.property === 'parentTask') {
        updated = this.options.tasks.updateRelationships(updated.id, { expectedUpdatedAt: updated.updatedAt, parentTaskId: mutation.targetId === taskBoardEmptyGroupId ? null : mutation.targetId });
      }
    }
    if (!plan.removeTagOccurrenceOnly && !this.taskBelongsToLane(updated, plan.groupBy, plan.subgroupBy, plan.input.target.groupId, plan.targetSubgroupId)) {
      throw new WorkManagementRouteError(409, { error: 'ZEUS_TASK_BOARD_TARGET_REJECTED', message: 'Task fields did not resolve to the target lane.', task: updated, board: currentBoard });
    }
    const orderedTaskIds = [...plan.targetLaneTaskIds];
    if (!plan.removeTagOccurrenceOnly) orderedTaskIds.splice(plan.insertionIndex, 0, updated.id);
    const board = this.options.taskBoards.replaceLaneOrder({
      projectId: plan.projectId,
      taskId: updated.id,
      layoutKey: plan.layoutKey,
      source: { groupId: plan.input.source.groupId, subgroupId: plan.sourceSubgroupId },
      target: { groupId: plan.input.target.groupId, subgroupId: plan.targetSubgroupId },
      orderedTaskIds,
      expectedRevision: plan.input.expectedViewRevision,
      includeTaskInTarget: !plan.removeTagOccurrenceOnly,
    });
    this.options.recordTaskEvent({
      taskId: updated.id,
      eventType: 'task.board.moved',
      title: '任务已在看板中移动',
      payload: {
        projectId: plan.projectId,
        groupBy: plan.groupBy,
        subgroupBy: plan.subgroupBy,
        source: { groupId: plan.input.source.groupId, subgroupId: plan.sourceSubgroupId },
        target: { groupId: plan.input.target.groupId, subgroupId: plan.targetSubgroupId },
        revision: board.revision,
        commandId: context.commandId,
      },
    });
    this.options.appendAuditLog({
      actorType: context.actor.kind,
      ...(context.actor.id ? { actorRef: context.actor.id } : {}),
      action: 'task.board.task.moved',
      resourceType: 'task',
      resourceId: updated.id,
      payload: {
        taskId: updated.id,
        projectId: plan.projectId,
        groupBy: plan.groupBy,
        subgroupBy: plan.subgroupBy,
        source: { groupId: plan.input.source.groupId, subgroupId: plan.sourceSubgroupId },
        target: { groupId: plan.input.target.groupId, subgroupId: plan.targetSubgroupId },
        revision: board.revision,
        commandId: context.commandId,
      },
    });
    this.options.afterCommit(() => this.options.publishRealtimeEvent('task.board.updated', { projectId: plan.projectId, taskId: updated.id, revision: board.revision, reason: 'move' }));
    return { task: updated, board };
  }

  async prepareRuntimeAction(action: TaskRuntimeCommandAction, taskId: string): Promise<PreparedTaskOperation<TaskRuntimeActionPlan>> {
    const task = this.requireTask(taskId);
    if ((action === 'run' || action === 'continue') && this.options.isManagementStatusTerminal(task)) {
      throw routeError(409, 'ZEUS_TASK_REOPEN_REQUIRED', `This task is completed or cancelled. Reopen the task before ${action === 'run' ? 'starting it again' : 'continuing it'}.`);
    }
    const project = this.requireProject(task.projectId);
    this.options.validateRuntimeAction(action, task, project);
    if (action === 'pause') getNextTaskStatus(task.status, 'paused');
    if (action === 'cancel') getNextTaskStatus(task.status, 'cancelled');
    return { resourceId: task.id, state: { action, taskId: task.id, project, initialStatus: task.status } };
  }

  invokeRuntimeAction(action: TaskRuntimeCommandAction, plan: TaskRuntimeActionPlan, operationIdentity: string): Promise<TRuntimeEffect> {
    const task = this.requireTask(plan.taskId);
    return action === 'pause' || action === 'cancel' ? this.options.stopRuntimeSessions(task.id) : this.options.invokeRuntimeAction(action, task, plan.project, operationIdentity);
  }

  mutateRuntimeAction(action: TaskRuntimeCommandAction, plan: TaskRuntimeActionPlan, effect: TRuntimeEffect, context: WorkManagementTaskCommandContext): TRuntimeResult | ZeusTaskRecord {
    let task = this.requireTask(plan.taskId);
    let result: TRuntimeResult | ZeusTaskRecord;
    if (action === 'pause' || action === 'cancel') {
      const target: TaskStatus = action === 'pause' ? 'paused' : 'cancelled';
      const previous = task;
      task = this.options.tasks.updateStatus(task.id, getNextTaskStatus(task.status, target));
      this.recordStatusChanged(previous, task, `task.runtime.${action}`, context);
      result = task;
    } else {
      result = this.options.finalizeStartedRuntimeAction(action, task, effect, context);
      task = this.requireTask(plan.taskId);
      this.options.recordTaskEvent({
        taskId: task.id,
        eventType: `task.runtime.${action}.accepted`,
        title: action === 'run' ? '任务 Runtime 启动命令已接纳' : '任务 Runtime 继续命令已接纳',
        payload: { status: task.status, commandId: context.commandId, operationIdentity: context.operationIdentity },
      });
    }
    this.options.afterCommit(() => this.options.publishRealtimeEvent('task.status.changed', statusRealtimePayload(task, plan.initialStatus, task.status, `task.runtime.${action}`)));
    return result;
  }

  archiveTask(taskId: string, context: WorkManagementTaskCommandContext): ZeusTaskRecord {
    const existing = this.requireTask(taskId);
    const archived = this.options.tasks.archive(existing.id);
    this.options.recordTaskEvent({ taskId: archived.id, eventType: 'task.archived', title: '任务已归档', payload: { status: archived.status, archived: true, commandId: context.commandId } });
    return archived;
  }

  restoreTask(taskId: string, context: WorkManagementTaskCommandContext): ZeusTaskRecord {
    const existing = this.requireTask(taskId);
    const restored = this.options.tasks.restore(existing.id);
    this.options.recordTaskEvent({ taskId: restored.id, eventType: 'task.restored', title: '任务已恢复', payload: { status: restored.status, archived: false, commandId: context.commandId } });
    return restored;
  }

  updateTask(taskId: string, input: UpdateTaskContentCommandInput, context: WorkManagementTaskCommandContext): ZeusTaskRecord {
    const existing = this.requireTask(taskId);
    requireExpectedUpdatedAt(input.expectedUpdatedAt);
    if (input.title !== undefined && typeof input.title !== 'string') throw routeError(400, 'ZEUS_INVALID_TASK_TITLE', 'Task title must be a string.');
    if (typeof input.title === 'string' && !input.title.trim()) throw routeError(400, 'ZEUS_TASK_TITLE_REQUIRED', 'Task title is required.');
    if (input.taskType !== undefined && !isTaskType(input.taskType)) throw routeError(400, 'ZEUS_INVALID_TASK_TYPE', 'Task type must be requirement, defect or optimization.');
    if (input.description !== undefined && typeof input.description !== 'string') throw routeError(400, 'ZEUS_INVALID_TASK_DESCRIPTION', 'Task description must be a string.');
    if ([input.defectCurrentState, input.defectExpectedOutcome, input.defectReproductionSteps, input.optimizationCurrentState, input.optimizationExpectedOutcome].some((value) => value !== undefined && typeof value !== 'string')) {
      throw routeError(400, 'ZEUS_INVALID_TASK_CONTENT', 'Task type content fields must be strings when provided.');
    }
    if (input.priority !== undefined && !isTaskPriority(input.priority)) throw routeError(400, 'ZEUS_INVALID_TASK_PRIORITY', 'Task priority must be one of p0, p1, p2, p3 or p4.');
    if (input.tags !== undefined && (!Array.isArray(input.tags) || !input.tags.every((tag) => typeof tag === 'string'))) throw routeError(400, 'ZEUS_INVALID_TASK_TAGS', 'Task tags must be an array of strings.');
    const attachments = input.attachments === undefined ? undefined : normalizeWorkManagementTaskAttachments(input.attachments);
    if (attachments === null) throw routeError(400, 'ZEUS_INVALID_TASK_ATTACHMENTS', 'Task attachments must contain at most 24 valid field-owned attachment references.');
    if (input.sourceContext !== undefined && (!input.sourceContext || typeof input.sourceContext !== 'object' || Array.isArray(input.sourceContext))) {
      throw routeError(400, 'ZEUS_INVALID_TASK_SOURCE_CONTEXT', 'Task source context must be an object.');
    }
    if (input.sourceContext !== undefined && attachments !== undefined) throw routeError(400, 'ZEUS_AMBIGUOUS_TASK_CONTEXT_UPDATE', 'sourceContext and attachments cannot be updated in the same request.');
    let sourceContext = input.sourceContext;
    if (sourceContext && Object.prototype.hasOwnProperty.call(sourceContext, 'attachments')) {
      const normalizedAttachments = normalizeWorkManagementTaskAttachments(sourceContext.attachments);
      if (normalizedAttachments === null) throw routeError(400, 'ZEUS_INVALID_TASK_ATTACHMENTS', 'Task source context contains invalid field-owned attachment references.');
      sourceContext = { ...sourceContext, attachments: normalizedAttachments };
    }
    if ([input.allowCodeChanges, input.allowTests, input.allowGitCommit].some((value) => value !== undefined && typeof value !== 'boolean')) {
      throw routeError(400, 'ZEUS_INVALID_TASK_PERMISSIONS', 'allowCodeChanges, allowTests and allowGitCommit must be booleans when provided');
    }
    const result = this.options.tasks.updateContent(existing.id, {
      expectedUpdatedAt: input.expectedUpdatedAt!,
      title: input.title,
      taskType: input.taskType,
      description: input.description,
      defectCurrentState: input.defectCurrentState,
      defectExpectedOutcome: input.defectExpectedOutcome,
      defectReproductionSteps: input.defectReproductionSteps,
      optimizationCurrentState: input.optimizationCurrentState,
      optimizationExpectedOutcome: input.optimizationExpectedOutcome,
      priority: input.priority,
      tags: input.tags,
      attachments,
      sourceContext,
      allowCodeChanges: input.allowCodeChanges,
      allowTests: input.allowTests,
      allowGitCommit: input.allowGitCommit,
    });
    if (result.changedFields.length === 0) return result.task;
    this.options.recordTaskEvent({
      taskId: result.task.id,
      eventType: 'task.updated',
      title: '任务内容已更新',
      payload: {
        changedFields: result.changedFields,
        tagCount: { before: result.tagCountBefore, after: result.tagCountAfter },
        attachmentCount: { before: result.attachmentCountBefore, after: result.attachmentCountAfter },
        previousUpdatedAt: result.previousUpdatedAt,
        updatedAt: result.task.updatedAt,
        commandId: context.commandId,
      },
    });
    this.auditTask(context, 'task.updated', result.task, {
      changedFields: result.changedFields,
      tagCountBefore: result.tagCountBefore,
      tagCountAfter: result.tagCountAfter,
      attachmentCountBefore: result.attachmentCountBefore,
      attachmentCountAfter: result.attachmentCountAfter,
    });
    this.publishTaskUpdated(result.task, result.changedFields);
    return result.task;
  }

  updateTaskTags(taskId: string, input: UpdateTaskTagsCommandInput, context: WorkManagementTaskCommandContext): ZeusTaskRecord {
    const existing = this.requireTask(taskId);
    requireExpectedUpdatedAt(input.expectedUpdatedAt);
    if (!Array.isArray(input.tags) || !input.tags.every((tag) => typeof tag === 'string')) throw routeError(400, 'ZEUS_INVALID_TASK_TAGS', 'Task tags must be an array of strings.');
    const result = this.options.tasks.updateContent(existing.id, { expectedUpdatedAt: input.expectedUpdatedAt!, tags: input.tags });
    if (result.changedFields.length === 0) return result.task;
    this.options.recordTaskEvent({
      taskId: result.task.id,
      eventType: 'task.tags.updated',
      title: '任务标签已更新',
      payload: { changedFields: ['tags'], tagCount: { before: result.tagCountBefore, after: result.tagCountAfter }, previousUpdatedAt: result.previousUpdatedAt, updatedAt: result.task.updatedAt, commandId: context.commandId },
    });
    this.publishTaskUpdated(result.task, ['tags']);
    return result.task;
  }

  updateTaskRelationships(taskId: string, input: UpdateTaskRelationshipsCommandInput, context: WorkManagementTaskCommandContext): ZeusTaskRecord {
    const existing = this.requireTask(taskId);
    requireExpectedUpdatedAt(input.expectedUpdatedAt);
    if (input.parentTaskId !== undefined && input.parentTaskId !== null && typeof input.parentTaskId !== 'string') throw routeError(400, 'ZEUS_INVALID_TASK_PARENT', 'parentTaskId must be a string or null.');
    if (input.relatedTaskIds !== undefined && (!Array.isArray(input.relatedTaskIds) || !input.relatedTaskIds.every((taskId) => typeof taskId === 'string'))) {
      throw routeError(400, 'ZEUS_INVALID_RELATED_TASKS', 'relatedTaskIds must be an array of task ids.');
    }
    const updated = this.options.tasks.updateRelationships(existing.id, {
      expectedUpdatedAt: input.expectedUpdatedAt!,
      parentTaskId: input.parentTaskId,
      relatedTaskIds: input.relatedTaskIds,
    });
    if (updated.updatedAt === existing.updatedAt) return updated;
    this.options.recordTaskEvent({
      taskId: updated.id,
      eventType: 'task.relationships.updated',
      title: '任务关系已更新',
      payload: { parentTaskId: { before: existing.parentTaskId, after: updated.parentTaskId }, relatedTaskIds: { before: existing.relatedTaskIds, after: updated.relatedTaskIds }, commandId: context.commandId },
    });
    this.auditTask(context, 'task.relationships.updated', updated, { parentTaskId: updated.parentTaskId, relatedTaskIds: updated.relatedTaskIds });
    this.publishTaskUpdated(updated, ['relationships']);
    return updated;
  }

  deleteTask(taskId: string, input: DeleteTaskCommandInput, context: WorkManagementTaskCommandContext): ReturnType<TaskRepository['delete']> {
    const existing = this.requireTask(taskId);
    if (input.childStrategy !== undefined && !['reparent', 'delete_descendants', 'make_roots'].includes(input.childStrategy)) {
      throw routeError(400, 'ZEUS_TASK_DELETE_STRATEGY_INVALID', 'Unknown child handling strategy.');
    }
    const deleted = this.options.tasks.delete(existing.id, input);
    this.options.recordTaskEvent({
      taskId: deleted.task.id,
      eventType: 'task.deleted',
      title: '任务已删除',
      payload: { softDeleted: true, deletedTaskIds: deleted.deletedTaskIds, movedChildTaskIds: deleted.movedChildTaskIds, childStrategy: input.childStrategy ?? null, commandId: context.commandId },
    });
    this.auditTask(context, 'task.deleted', deleted.task, { deletedTaskIds: deleted.deletedTaskIds, movedChildTaskIds: deleted.movedChildTaskIds });
    return deleted;
  }

  private validateBoardPropertyMutation(task: ZeusTaskRecord, mutation: TaskBoardPropertyMutation): void {
    if (mutation.sourceId === mutation.targetId) return;
    if (mutation.property === 'managementStatus') {
      if (!this.options.isConfiguredManagementStatus(task.projectId, mutation.targetId)) throw routeError(400, 'ZEUS_INVALID_TASK_MANAGEMENT_STATUS', '目标任务状态已经不存在。');
      return;
    }
    if (mutation.property === 'priority') {
      if (!isTaskPriority(mutation.targetId)) throw routeError(400, 'ZEUS_INVALID_TASK_PRIORITY', '目标优先级无效。');
      return;
    }
    if (mutation.property === 'taskType') {
      if (!isTaskType(mutation.targetId)) throw routeError(400, 'ZEUS_INVALID_TASK_TYPE', '目标任务类型无效。');
      return;
    }
    if (mutation.property === 'tags') return;
    if (mutation.property === 'parentTask') {
      try {
        this.options.tasks.validateParentChange(task.id, mutation.targetId === taskBoardEmptyGroupId ? null : mutation.targetId);
      } catch (error) {
        const code = errorCode(error) ?? 'ZEUS_TASK_PARENT_INVALID';
        throw routeError(code === 'ZEUS_TASK_PARENT_NOT_FOUND' || code === 'ZEUS_TASK_NOT_FOUND' ? 404 : 409, code, error instanceof Error ? error.message : 'Invalid task parent.');
      }
      return;
    }
    throw routeError(409, 'ZEUS_TASK_BOARD_DERIVED_GROUP_READ_ONLY', '执行状态、分支状态和任务来源由真实运行事实派生，不能通过跨列拖动修改。');
  }

  private taskBelongsToLane(task: ZeusTaskRecord, groupBy: TaskBoardGroupProperty, subgroupBy: TaskBoardGroupProperty | null, groupId: string, subgroupId: string): boolean {
    if (!this.options.taskBoardGroupValues(task, groupBy).includes(groupId)) return false;
    return subgroupBy ? this.options.taskBoardGroupValues(task, subgroupBy).includes(subgroupId) : subgroupId === '';
  }

  private recordStatusChanged(existing: ZeusTaskRecord, updated: ZeusTaskRecord, source: string, context: WorkManagementTaskCommandContext): void {
    this.options.recordTaskEvent({
      taskId: updated.id,
      eventType: source,
      title: this.options.taskStatusEventTitle(updated.status),
      payload: { from: existing.status, to: updated.status, commandId: context.commandId },
    });
    this.options.appendAuditLog({
      actorType: context.actor.kind,
      ...(context.actor.id ? { actorRef: context.actor.id } : {}),
      action: 'task.status.changed',
      resourceType: 'task',
      resourceId: updated.id,
      payload: { taskId: updated.id, projectId: updated.projectId, from: existing.status, to: updated.status, source, commandId: context.commandId },
    });
  }

  private auditTask(context: WorkManagementTaskCommandContext, action: string, task: ZeusTaskRecord, payload: Record<string, unknown>): void {
    this.options.appendAuditLog({
      actorType: context.actor.kind,
      ...(context.actor.id ? { actorRef: context.actor.id } : {}),
      action,
      resourceType: 'task',
      resourceId: task.id,
      payload: { taskId: task.id, projectId: task.projectId, commandId: context.commandId, ...payload },
    });
  }

  private publishTaskUpdated(task: ZeusTaskRecord, changedFields: readonly string[]): void {
    this.options.afterCommit(() => this.options.publishRealtimeEvent('task.updated', { taskId: task.id, projectId: task.projectId, changedFields, updatedAt: task.updatedAt }));
  }

  private requireTask(taskId: string): ZeusTaskRecord {
    const task = this.options.tasks.getById(taskId);
    if (!task) throw routeError(404, 'ZEUS_TASK_NOT_FOUND', 'Task not found');
    return task;
  }

  private requireProject(projectId: string): ZeusProjectRecord {
    const project = this.options.projects.getById(projectId);
    if (!project) throw routeError(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
    return project;
  }
}

function requireExpectedUpdatedAt(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value) throw routeError(400, 'ZEUS_TASK_EDIT_VERSION_REQUIRED', 'expectedUpdatedAt is required when updating a task.');
}

function validateBoardMoveInput(input: TaskBoardMoveRequest): void {
  assertExactKeys(input, ['confirmWorktreeCleanup', 'expectedTaskUpdatedAt', 'expectedViewRevision', 'source', 'target', 'taskId'], 'Task board move input', true);
  if (
    typeof input.taskId !== 'string' ||
    !input.taskId ||
    input.taskId.length > 256 ||
    typeof input.expectedTaskUpdatedAt !== 'string' ||
    !input.expectedTaskUpdatedAt ||
    input.expectedTaskUpdatedAt.length > 128 ||
    !Number.isSafeInteger(input.expectedViewRevision) ||
    input.expectedViewRevision < 0 ||
    !input.source ||
    !input.target ||
    typeof input.source.groupId !== 'string' ||
    typeof input.target.groupId !== 'string' ||
    input.source.groupId.length > 160 ||
    input.target.groupId.length > 160
  ) {
    throw routeError(400, 'ZEUS_INVALID_TASK_BOARD_MOVE', 'Task board move payload is invalid.');
  }
  assertExactKeys(input.source, ['groupId', 'subgroupId'], 'Task board move source', true);
  assertExactKeys(input.target, ['afterTaskId', 'beforeTaskId', 'groupId', 'subgroupId'], 'Task board move target', true);
  const optionalStrings = [input.source.subgroupId, input.target.subgroupId, input.target.beforeTaskId, input.target.afterTaskId];
  if (optionalStrings.some((value) => value !== undefined && value !== null && (typeof value !== 'string' || value.length > 160)) || (input.target.beforeTaskId && input.target.afterTaskId)) {
    throw routeError(400, 'ZEUS_INVALID_TASK_BOARD_MOVE', 'Task board move lane and anchors must be strings.');
  }
  if (input.confirmWorktreeCleanup !== undefined && typeof input.confirmWorktreeCleanup !== 'boolean') {
    throw routeError(400, 'ZEUS_INVALID_TASK_BOARD_MOVE', 'confirmWorktreeCleanup must be a boolean when provided.');
  }
}

function resolveBoardInsertionIndex(input: TaskBoardMoveRequest, targetLaneTaskIds: string[], existing: ZeusTaskRecord, board: TaskBoardViewSnapshot): number {
  if (input.target.beforeTaskId) {
    const index = targetLaneTaskIds.indexOf(input.target.beforeTaskId);
    if (index < 0) throw new WorkManagementRouteError(409, { error: 'ZEUS_TASK_BOARD_ANCHOR_CHANGED', message: 'Target card moved while dragging.', task: existing, board });
    return index;
  }
  if (input.target.afterTaskId) {
    const index = targetLaneTaskIds.indexOf(input.target.afterTaskId);
    if (index < 0) throw new WorkManagementRouteError(409, { error: 'ZEUS_TASK_BOARD_ANCHOR_CHANGED', message: 'Target card moved while dragging.', task: existing, board });
    return index + 1;
  }
  return targetLaneTaskIds.length;
}

function compareBoardTasks(left: ZeusTaskRecord, right: ZeusTaskRecord, rankByTaskId: Map<string, number>): number {
  const leftRank = rankByTaskId.get(left.id);
  const rightRank = rankByTaskId.get(right.id);
  if (leftRank !== undefined || rightRank !== undefined) return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
  return (left.taskSequence ?? Number.MAX_SAFE_INTEGER) - (right.taskSequence ?? Number.MAX_SAFE_INTEGER) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function statusRealtimePayload(task: ZeusTaskRecord, from: TaskStatus, to: TaskStatus, source: string): Record<string, unknown> {
  return { taskId: task.id, projectId: task.projectId, title: task.title, from, to, status: task.status, source };
}

function boardRevisionConflict(board: TaskBoardViewSnapshot, message: string): WorkManagementRouteError {
  return new WorkManagementRouteError(409, { error: 'ZEUS_TASK_BOARD_REVISION_CONFLICT', message, currentRevision: board.revision, board });
}

function editConflict(task: ZeusTaskRecord, message = 'Task changed after editing started.'): WorkManagementRouteError {
  return new WorkManagementRouteError(409, { error: 'ZEUS_TASK_EDIT_CONFLICT', message, currentUpdatedAt: task.updatedAt, task });
}

function routeError(statusCode: number, error: string, message: string): WorkManagementRouteError {
  return new WorkManagementRouteError(statusCode, { error, message });
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : null;
}

function assertExactKeys(value: object, allowed: readonly string[], label: string, optional = false): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw routeError(400, 'ZEUS_WORK_MANAGEMENT_COMMAND_INVALID', `${label} must be an object.`);
  const actual = Object.keys(value);
  const unexpected = actual.filter((key) => !allowed.includes(key));
  if (unexpected.length > 0 || (!optional && (actual.length !== allowed.length || allowed.some((key) => !actual.includes(key))))) {
    throw routeError(400, 'ZEUS_WORK_MANAGEMENT_COMMAND_INVALID', `${label} contains unsupported or missing fields.`);
  }
}
