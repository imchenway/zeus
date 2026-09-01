import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type {CommandActor, TaskAttachmentReference, TaskBoardMoveRequest} from '@zeus/shared';
import type {CommandDeliveryOutcome, TaskPriority, TaskType, ZeusTaskRecord} from '@zeus/storage';
import type {TaskStatus} from './taskCore.js';
import {
    type PreparedTaskStatusTelegramEffect,
    WorkManagementCommandApplication,
    WorkManagementCommandApplicationError,
    workManagementCommandHttpError,
    workManagementCommandTypes,
    workManagementExternalOutcome,
    type WorkManagementMutationRequest,
} from './workManagementCommandApplication.js';
import {WorkManagementRouteError} from './workManagementCoreCommandRoutes.js';

export interface UpdateTaskStatusCommandInput {
  status: TaskStatus;
}

export interface UpdateTaskManagementStatusCommandInput {
  status: string;
  expectedUpdatedAt: string;
  confirmWorktreeCleanup?: boolean;
  reopenConversationId?: string;
}

export type TaskRuntimeCommandAction = 'run' | 'pause' | 'continue' | 'cancel';
export type EmptyTaskRuntimeCommandInput = Record<string, never>;

export interface UpdateTaskContentCommandInput {
  expectedUpdatedAt?: string;
  title?: string;
  taskType?: TaskType;
  description?: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  priority?: TaskPriority;
  tags?: string[];
  attachments?: TaskAttachmentReference[];
  sourceContext?: Record<string, unknown>;
  allowCodeChanges?: boolean;
  allowTests?: boolean;
  allowGitCommit?: boolean;
}

export interface UpdateTaskTagsCommandInput {
  tags?: string[];
  expectedUpdatedAt?: string;
}

export interface UpdateTaskRelationshipsCommandInput {
  expectedUpdatedAt?: string;
  parentTaskId?: string | null;
  relatedTaskIds?: string[];
}

export interface DeleteTaskCommandInput {
  childStrategy?: 'reparent' | 'delete_descendants' | 'make_roots';
  replacementParentTaskId?: string;
}

export interface WorkManagementTaskCommandContext {
  commandId: string;
  operationIdentity: string;
  actor: CommandActor;
}

export interface PreparedConditionalTaskOperation<TState> {
  resourceId: string;
  requiresExternal: boolean;
  state: TState;
}

export interface PreparedTaskOperation<TState> {
  resourceId: string;
  state: TState;
}

type FailureOutcome = Exclude<CommandDeliveryOutcome, 'accepted'>;
type ErrorMapping = { statusCode: number; payload: Record<string, unknown> };

/**
 * 第二波 Work Management 只注册七条公开写入口。Core 与 External 共用同一命令应用；
 * Runtime、资源清理和 Telegram 不允许绕过 write marker。
 */
export function registerWorkManagementTaskCommandRoutes<TStatusPlan, TStatusResult, TManagementPlan, TManagementEffect, TManagementResult, TBoardPlan, TBoardEffect, TBoardResult, TRuntimePlan, TRuntimeEffect, TRuntimeResult>(options: {
  server: FastifyInstance;
  application: WorkManagementCommandApplication;
  prepareStatus(taskId: string, input: UpdateTaskStatusCommandInput): TStatusPlan;
  mutateStatus(plan: TStatusPlan, context: WorkManagementTaskCommandContext): { result: TStatusResult; telegramStatus?: string };
  bindStatusPostCommit(result: TStatusResult, effect: PreparedTaskStatusTelegramEffect | null): void;
  prepareManagementStatus(taskId: string, input: UpdateTaskManagementStatusCommandInput): Promise<PreparedConditionalTaskOperation<TManagementPlan>>;
  beforeManagementStatusWrite?(plan: TManagementPlan): Promise<void>;
  invokeManagementStatus(plan: TManagementPlan): Promise<TManagementEffect>;
  mutateManagementStatus(plan: TManagementPlan, effect: TManagementEffect | null, context: WorkManagementTaskCommandContext): TManagementResult;
  mutateManagementStatusFailure?(plan: TManagementPlan, outcome: FailureOutcome, error: unknown, context: WorkManagementTaskCommandContext): void;
  prepareTaskBoardMove(projectId: string, input: TaskBoardMoveRequest): Promise<PreparedConditionalTaskOperation<TBoardPlan>>;
  beforeTaskBoardMoveWrite?(plan: TBoardPlan): Promise<void>;
  invokeTaskBoardMove(plan: TBoardPlan): Promise<TBoardEffect>;
  mutateTaskBoardMove(plan: TBoardPlan, effect: TBoardEffect | null, context: WorkManagementTaskCommandContext): TBoardResult;
  mutateTaskBoardMoveFailure?(plan: TBoardPlan, outcome: FailureOutcome, error: unknown, context: WorkManagementTaskCommandContext): void;
  prepareRuntimeAction(action: TaskRuntimeCommandAction, taskId: string): Promise<PreparedTaskOperation<TRuntimePlan>>;
  beforeRuntimeActionWrite?(action: TaskRuntimeCommandAction, plan: TRuntimePlan, operationIdentity: string): Promise<void>;
  invokeRuntimeAction(action: TaskRuntimeCommandAction, plan: TRuntimePlan, operationIdentity: string): Promise<TRuntimeEffect>;
  mutateRuntimeAction(action: TaskRuntimeCommandAction, plan: TRuntimePlan, effect: TRuntimeEffect, context: WorkManagementTaskCommandContext): TRuntimeResult;
  mutateRuntimeActionFailure?(action: TaskRuntimeCommandAction, plan: TRuntimePlan, outcome: FailureOutcome, error: unknown, context: WorkManagementTaskCommandContext): void;
  runtimeSuccessStatusCode?(action: TaskRuntimeCommandAction, result: TRuntimeResult): number;
  archiveTask(taskId: string, context: WorkManagementTaskCommandContext): ZeusTaskRecord;
  restoreTask(taskId: string, context: WorkManagementTaskCommandContext): ZeusTaskRecord;
  updateTask(taskId: string, input: UpdateTaskContentCommandInput, context: WorkManagementTaskCommandContext): ZeusTaskRecord;
  updateTaskTags(taskId: string, input: UpdateTaskTagsCommandInput, context: WorkManagementTaskCommandContext): ZeusTaskRecord;
  updateTaskRelationships(taskId: string, input: UpdateTaskRelationshipsCommandInput, context: WorkManagementTaskCommandContext): ZeusTaskRecord;
  deleteTask(taskId: string, input: DeleteTaskCommandInput, context: WorkManagementTaskCommandContext): unknown;
  isExplicitRejection?(error: unknown): boolean;
  mapDomainError?(error: unknown): ErrorMapping | null;
}): void {
  options.server.patch('/api/tasks/:taskId/status', async (request: FastifyRequest<{ Params: { taskId: string }; Body: WorkManagementMutationRequest<UpdateTaskStatusCommandInput> }>, reply) => {
    try {
      const parsed = options.application.parse<UpdateTaskStatusCommandInput>({
        value: request.body,
        commandType: workManagementCommandTypes.taskStatusUpdate,
        scopeKind: 'task',
        expectedScopeId: () => request.params.taskId,
      });
      requireNullExpectedRevision(parsed.command.expectedRevision, 'Task status');
      const replay = options.application.replayAccepted<UpdateTaskStatusCommandInput, TStatusResult>({
        parsed,
        destinationIds: [taskStatusDestinationId],
        resourceId: request.params.taskId,
      });
      if (replay) return replay.result;
      const plan = options.prepareStatus(request.params.taskId, parsed.input);
      const mutation = options.application.executeCore({
        parsed,
        destinationId: taskStatusDestinationId,
        resourceId: request.params.taskId,
        mutateBusinessState: () => {
          const changed = options.mutateStatus(plan, contextOf(parsed));
          const effect = changed.telegramStatus ? options.application.enqueueTaskStatusTelegramEffectInCurrentTransaction({ parent: parsed, taskId: request.params.taskId, status: changed.telegramStatus }) : null;
          options.bindStatusPostCommit(changed.result, effect);
          return changed.result;
        },
      });
      return mutation.result;
    } catch (error) {
      return sendError(reply, error, options.mapDomainError);
    }
  });

  options.server.patch('/api/tasks/:taskId/management-status', async (request: FastifyRequest<{ Params: { taskId: string }; Body: WorkManagementMutationRequest<UpdateTaskManagementStatusCommandInput> }>, reply) => {
    try {
      const parsed = options.application.parse<UpdateTaskManagementStatusCommandInput>({
        value: request.body,
        commandType: workManagementCommandTypes.taskManagementStatusUpdate,
        scopeKind: 'task',
        expectedScopeId: () => request.params.taskId,
      });
      requireNullExpectedRevision(parsed.command.expectedRevision, 'Task management status');
      const replay = options.application.replayAccepted<UpdateTaskManagementStatusCommandInput, TManagementResult>({
        parsed,
        destinationIds: [taskManagementStatusCoreDestinationId, taskManagementStatusExternalDestinationId],
        resourceId: request.params.taskId,
      });
      if (replay) return replay.result;
      const prepared = await options.prepareManagementStatus(request.params.taskId, parsed.input);
      if (!prepared.requiresExternal) {
        return options.application.executeCore({
          parsed,
          destinationId: taskManagementStatusCoreDestinationId,
          resourceId: prepared.resourceId,
          mutateBusinessState: () => options.mutateManagementStatus(prepared.state, null, contextOf(parsed)),
        }).result;
      }
      return (
        await options.application.executeExternal({
          parsed,
          destinationId: taskManagementStatusExternalDestinationId,
          resourceId: prepared.resourceId,
          externalOperationId: `task-management-status:${parsed.operationIdentity}`,
          beforeWrite: () => options.beforeManagementStatusWrite?.(prepared.state) ?? Promise.resolve(),
          invoke: () => options.invokeManagementStatus(prepared.state),
          mutateAcceptedBusinessState: (effect) => options.mutateManagementStatus(prepared.state, effect, contextOf(parsed)),
          mutateFailureBusinessState: (outcome, error) => options.mutateManagementStatusFailure?.(prepared.state, outcome, error, contextOf(parsed)),
          isExplicitRejection: options.isExplicitRejection,
        })
      ).result;
    } catch (error) {
      return sendError(reply, error, options.mapDomainError);
    }
  });

  options.server.post('/api/projects/:projectId/task-board/moves', async (request: FastifyRequest<{ Params: { projectId: string }; Body: WorkManagementMutationRequest<TaskBoardMoveRequest> }>, reply) => {
    try {
      const parsed = options.application.parse<TaskBoardMoveRequest>({
        value: request.body,
        commandType: workManagementCommandTypes.taskBoardMove,
        scopeKind: 'project',
        expectedScopeId: () => request.params.projectId,
      });
      if (parsed.command.expectedRevision !== parsed.input.expectedViewRevision) {
        throw new WorkManagementCommandApplicationError('ZEUS_WORK_MANAGEMENT_COMMAND_INVALID', 'Task board move command revision must equal input.expectedViewRevision.', 409);
      }
      const replay = options.application.replayAccepted<TaskBoardMoveRequest, TBoardResult>({
        parsed,
        destinationIds: [taskBoardMoveCoreDestinationId, taskBoardMoveExternalDestinationId],
        resourceId: parsed.input.taskId,
      });
      if (replay) return replay.result;
      const prepared = await options.prepareTaskBoardMove(request.params.projectId, parsed.input);
      if (!prepared.requiresExternal) {
        return options.application.executeCore({
          parsed,
          destinationId: taskBoardMoveCoreDestinationId,
          resourceId: prepared.resourceId,
          mutateBusinessState: () => options.mutateTaskBoardMove(prepared.state, null, contextOf(parsed)),
        }).result;
      }
      return (
        await options.application.executeExternal({
          parsed,
          destinationId: taskBoardMoveExternalDestinationId,
          resourceId: prepared.resourceId,
          externalOperationId: `task-board-move:${parsed.operationIdentity}`,
          beforeWrite: () => options.beforeTaskBoardMoveWrite?.(prepared.state) ?? Promise.resolve(),
          invoke: () => options.invokeTaskBoardMove(prepared.state),
          mutateAcceptedBusinessState: (effect) => options.mutateTaskBoardMove(prepared.state, effect, contextOf(parsed)),
          mutateFailureBusinessState: (outcome, error) => options.mutateTaskBoardMoveFailure?.(prepared.state, outcome, error, contextOf(parsed)),
          isExplicitRejection: options.isExplicitRejection,
        })
      ).result;
    } catch (error) {
      return sendError(reply, error, options.mapDomainError);
    }
  });

  options.server.post('/api/tasks/:taskId/run', runtimeHandler(options, 'run', workManagementCommandTypes.taskRun));
  options.server.post('/api/tasks/:taskId/pause', runtimeHandler(options, 'pause', workManagementCommandTypes.taskPause));
  options.server.post('/api/tasks/:taskId/continue', runtimeHandler(options, 'continue', workManagementCommandTypes.taskContinue));
  options.server.post('/api/tasks/:taskId/cancel', runtimeHandler(options, 'cancel', workManagementCommandTypes.taskCancel));

  registerTaskCoreMutation(options, 'post', '/api/tasks/:taskId/archive', workManagementCommandTypes.taskArchive, (taskId, _input, context) => options.archiveTask(taskId, context));
  registerTaskCoreMutation(options, 'post', '/api/tasks/:taskId/restore', workManagementCommandTypes.taskRestore, (taskId, _input, context) => options.restoreTask(taskId, context));
  registerTaskCoreMutation<UpdateTaskContentCommandInput>(options, 'patch', '/api/tasks/:taskId', workManagementCommandTypes.taskUpdate, options.updateTask);
  registerTaskCoreMutation<UpdateTaskTagsCommandInput>(options, 'put', '/api/tasks/:taskId/tags', workManagementCommandTypes.taskTagsUpdate, options.updateTaskTags);
  registerTaskCoreMutation<UpdateTaskRelationshipsCommandInput>(options, 'patch', '/api/tasks/:taskId/relationships', workManagementCommandTypes.taskRelationshipsUpdate, options.updateTaskRelationships);
  registerTaskCoreMutation<DeleteTaskCommandInput>(options, 'delete', '/api/tasks/:taskId', workManagementCommandTypes.taskDelete, options.deleteTask);
}

function registerTaskCoreMutation<TInput extends object = Record<string, never>>(
  options: {
    server: FastifyInstance;
    application: WorkManagementCommandApplication;
    mapDomainError?(error: unknown): ErrorMapping | null;
  },
  method: 'post' | 'patch' | 'put' | 'delete',
  path: string,
  commandType:
    | typeof workManagementCommandTypes.taskArchive
    | typeof workManagementCommandTypes.taskRestore
    | typeof workManagementCommandTypes.taskUpdate
    | typeof workManagementCommandTypes.taskTagsUpdate
    | typeof workManagementCommandTypes.taskRelationshipsUpdate
    | typeof workManagementCommandTypes.taskDelete,
  mutate: (taskId: string, input: TInput, context: WorkManagementTaskCommandContext) => unknown,
): void {
  options.server[method](path, async (request: FastifyRequest<{ Params: { taskId: string }; Body: WorkManagementMutationRequest<TInput> }>, reply) => {
    try {
      const parsed = options.application.parse<TInput>({
        value: request.body,
        commandType,
        scopeKind: 'task',
        expectedScopeId: () => request.params.taskId,
      });
      requireNullExpectedRevision(parsed.command.expectedRevision, commandType);
      const replay = options.application.replayAcceptedCore<TInput, unknown>({ parsed, destinationId: taskApplicationDestinationId, resourceId: request.params.taskId });
      if (replay) return replay.result;
      return options.application.executeCore({
        parsed,
        destinationId: taskApplicationDestinationId,
        resourceId: request.params.taskId,
        mutateBusinessState: () => mutate(request.params.taskId, parsed.input, contextOf(parsed)),
      }).result;
    } catch (error) {
      return sendError(reply, error, options.mapDomainError);
    }
  });
}

function runtimeHandler<TRuntimePlan, TRuntimeEffect, TRuntimeResult>(
  options: {
    application: WorkManagementCommandApplication;
    prepareRuntimeAction(action: TaskRuntimeCommandAction, taskId: string): Promise<PreparedTaskOperation<TRuntimePlan>>;
    beforeRuntimeActionWrite?(action: TaskRuntimeCommandAction, plan: TRuntimePlan, operationIdentity: string): Promise<void>;
    invokeRuntimeAction(action: TaskRuntimeCommandAction, plan: TRuntimePlan, operationIdentity: string): Promise<TRuntimeEffect>;
    mutateRuntimeAction(action: TaskRuntimeCommandAction, plan: TRuntimePlan, effect: TRuntimeEffect, context: WorkManagementTaskCommandContext): TRuntimeResult;
    mutateRuntimeActionFailure?(action: TaskRuntimeCommandAction, plan: TRuntimePlan, outcome: FailureOutcome, error: unknown, context: WorkManagementTaskCommandContext): void;
    runtimeSuccessStatusCode?(action: TaskRuntimeCommandAction, result: TRuntimeResult): number;
    isExplicitRejection?(error: unknown): boolean;
    mapDomainError?(error: unknown): ErrorMapping | null;
  },
  action: TaskRuntimeCommandAction,
  commandType: (typeof workManagementCommandTypes)['taskRun' | 'taskPause' | 'taskContinue' | 'taskCancel'],
) {
  return async (request: FastifyRequest<{ Params: { taskId: string }; Body: WorkManagementMutationRequest<EmptyTaskRuntimeCommandInput> }>, reply: FastifyReply) => {
    try {
      const parsed = options.application.parse<EmptyTaskRuntimeCommandInput>({
        value: request.body,
        commandType,
        scopeKind: 'task',
        expectedScopeId: () => request.params.taskId,
      });
      if (Object.keys(parsed.input).length !== 0) {
        throw new WorkManagementCommandApplicationError('ZEUS_WORK_MANAGEMENT_COMMAND_INVALID', `Task ${action} input must be an empty object.`, 400);
      }
      requireNullExpectedRevision(parsed.command.expectedRevision, `Task ${action}`);
      const replay = options.application.replayAccepted<EmptyTaskRuntimeCommandInput, TRuntimeResult>({
        parsed,
        destinationIds: [taskRuntimeDestinationId(action)],
        resourceId: request.params.taskId,
      });
      if (replay) return sendRuntimeResult(reply, action, replay.result, options.runtimeSuccessStatusCode);
      const prepared = await options.prepareRuntimeAction(action, request.params.taskId);
      const mutation = await options.application.executeExternal({
        parsed,
        destinationId: taskRuntimeDestinationId(action),
        resourceId: prepared.resourceId,
        externalOperationId: `task-runtime-${action}:${parsed.operationIdentity}`,
        beforeWrite: () => options.beforeRuntimeActionWrite?.(action, prepared.state, parsed.operationIdentity) ?? Promise.resolve(),
        invoke: () => options.invokeRuntimeAction(action, prepared.state, parsed.operationIdentity),
        mutateAcceptedBusinessState: (effect) => options.mutateRuntimeAction(action, prepared.state, effect, contextOf(parsed)),
        mutateFailureBusinessState: (outcome, error) => options.mutateRuntimeActionFailure?.(action, prepared.state, outcome, error, contextOf(parsed)),
        isExplicitRejection: options.isExplicitRejection,
      });
      return sendRuntimeResult(reply, action, mutation.result, options.runtimeSuccessStatusCode);
    } catch (error) {
      return sendError(reply, error, options.mapDomainError);
    }
  };
}

function sendRuntimeResult<TResult>(reply: FastifyReply, action: TaskRuntimeCommandAction, result: TResult, resolveStatusCode?: (action: TaskRuntimeCommandAction, result: TResult) => number): unknown {
  const statusCode = resolveStatusCode?.(action, result);
  return statusCode ? reply.code(statusCode).send(result) : result;
}

function requireNullExpectedRevision(value: number | null, label: string): void {
  if (value !== null) throw new WorkManagementCommandApplicationError('ZEUS_WORK_MANAGEMENT_COMMAND_INVALID', `${label} currently requires command expectedRevision=null.`, 409);
}

function contextOf(parsed: ReturnType<WorkManagementCommandApplication['parse']>): WorkManagementTaskCommandContext {
  return { commandId: parsed.command.commandId, operationIdentity: parsed.operationIdentity, actor: parsed.command.actor };
}

function sendError(reply: FastifyReply, error: unknown, mapDomainError?: (error: unknown) => ErrorMapping | null): unknown {
  if (error instanceof WorkManagementRouteError) return reply.code(error.statusCode).send(error.payload);
  const externalOutcome = workManagementExternalOutcome(error);
  if (externalOutcome === 'outcome_unknown_after_write') {
    return reply.code(503).send({
      error: 'ZEUS_WORK_MANAGEMENT_EXTERNAL_OUTCOME_UNKNOWN',
      message: 'External write started but its result is unknown. Automatic replay is blocked; reconcile the Runtime or external system before retrying.',
      recoveryRequired: true,
    });
  }
  const commandError = workManagementCommandHttpError(error);
  if (commandError) return reply.code(commandError.statusCode).send(commandError.payload);
  const domainError = mapDomainError?.(error);
  if (domainError) return reply.code(domainError.statusCode).send(domainError.payload);
  throw error;
}

const taskStatusDestinationId = 'work-management-task-status-application';
const taskManagementStatusCoreDestinationId = 'work-management-task-management-status-application';
const taskManagementStatusExternalDestinationId = 'work-management-task-management-status-external';
const taskBoardMoveCoreDestinationId = 'work-management-task-board-move-application';
const taskBoardMoveExternalDestinationId = 'work-management-task-board-move-external';
const taskApplicationDestinationId = 'work-management-task-application';

function taskRuntimeDestinationId(action: TaskRuntimeCommandAction): string {
  return `work-management-task-runtime-${action}`;
}
