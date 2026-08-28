import type { UpdateTaskStageInput, ZeusTaskWorkflowSnapshot } from '@zeus/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TaskStageApplication, taskStageApplicationError, type CaptureTaskStageDeliverableInput, type CreateManualTaskStageDeliverableInput, type InitializeTaskWorkflowInput } from './taskStageApplication.js';
import { WorkManagementCommandApplication, type WorkManagementCommandType, type WorkManagementMutationRequest, workManagementCommandHttpError, workManagementCommandTypes } from './workManagementCommandApplication.js';

type TaskParams = { taskId: string };
type StageParams = TaskParams & { stageId: string };
type DeliverableParams = TaskParams & { deliverableId: string };

interface TaskStageRouteOptions {
  server: FastifyInstance;
  application: TaskStageApplication;
  commands: WorkManagementCommandApplication;
  save(): Promise<void>;
}

/** 所有阶段写入都携带 Work Management Command Envelope；读取仍是任务作用域投影。 */
export function registerTaskStageRoutes(options: TaskStageRouteOptions): void {
  options.server.get('/api/tasks/:taskId/workflow', async (request: FastifyRequest<{ Params: TaskParams }>, reply) => executeRead(reply, () => options.application.readWorkflow(request.params.taskId)));

  options.server.post('/api/tasks/:taskId/workflow', async (request: FastifyRequest<{ Params: TaskParams; Body: WorkManagementMutationRequest<InitializeTaskWorkflowInput> }>, reply) =>
    executeMutation(options, reply, request.params.taskId, request.body, workManagementCommandTypes.taskWorkflowInitialize, 'task-stage-workflow', `task_workflow:${request.params.taskId}`, (input) =>
      options.application.initializeWorkflow(request.params.taskId, input),
    ),
  );

  options.server.patch('/api/tasks/:taskId/workflow/stages/:stageId', async (request: FastifyRequest<{ Params: StageParams; Body: WorkManagementMutationRequest<UpdateTaskStageInput> }>, reply) =>
    executeMutation(options, reply, request.params.taskId, request.body, workManagementCommandTypes.taskStageUpdate, 'task-stage-repository', `task_stage:${request.params.stageId}`, (input) =>
      options.application.updateStage(request.params.taskId, request.params.stageId, input),
    ),
  );

  options.server.post('/api/tasks/:taskId/workflow/stages/:stageId/deliverables/capture', async (request: FastifyRequest<{ Params: StageParams; Body: WorkManagementMutationRequest<CaptureTaskStageDeliverableInput> }>, reply) =>
    executeMutation(options, reply, request.params.taskId, request.body, workManagementCommandTypes.taskStageDeliverableCapture, 'task-stage-artifact-capture', `task_stage:${request.params.stageId}`, (input) =>
      options.application.captureLatestConversationOutput(request.params.taskId, request.params.stageId, input),
    ),
  );

  options.server.post('/api/tasks/:taskId/workflow/stages/:stageId/deliverables', async (request: FastifyRequest<{ Params: StageParams; Body: WorkManagementMutationRequest<CreateManualTaskStageDeliverableInput> }>, reply) =>
    executeMutation(options, reply, request.params.taskId, request.body, workManagementCommandTypes.taskStageDeliverableCreate, 'task-stage-artifact-create', `task_stage:${request.params.stageId}`, (input) =>
      options.application.createManualDeliverable(request.params.taskId, request.params.stageId, input),
    ),
  );

  options.server.post('/api/tasks/:taskId/workflow/stages/:stageId/skip', async (request: FastifyRequest<{ Params: StageParams; Body: WorkManagementMutationRequest<{ expectedRevision: number; reason: string }> }>, reply) =>
    executeMutation(options, reply, request.params.taskId, request.body, workManagementCommandTypes.taskStageSkip, 'task-stage-repository', `task_stage:${request.params.stageId}`, (input) =>
      options.application.skipStage(request.params.taskId, request.params.stageId, input),
    ),
  );

  options.server.post('/api/tasks/:taskId/workflow/deliverables/:deliverableId/accept', async (request: FastifyRequest<{ Params: DeliverableParams; Body: WorkManagementMutationRequest<{ expectedStageRevision: number }> }>, reply) =>
    executeMutation(options, reply, request.params.taskId, request.body, workManagementCommandTypes.taskStageDeliverableAccept, 'task-stage-repository', `task_stage_deliverable:${request.params.deliverableId}`, (input) =>
      options.application.acceptDeliverable(request.params.taskId, request.params.deliverableId, input),
    ),
  );

  options.server.post(
    '/api/tasks/:taskId/workflow/deliverables/:deliverableId/request-changes',
    async (request: FastifyRequest<{ Params: DeliverableParams; Body: WorkManagementMutationRequest<{ expectedStageRevision: number; reason: string }> }>, reply) =>
      executeMutation(options, reply, request.params.taskId, request.body, workManagementCommandTypes.taskStageDeliverableRequestChanges, 'task-stage-repository', `task_stage_deliverable:${request.params.deliverableId}`, (input) =>
        options.application.requestChanges(request.params.taskId, request.params.deliverableId, input),
      ),
  );

  options.server.get('/api/tasks/:taskId/workflow/deliverables/:deliverableId/content', async (request: FastifyRequest<{ Params: DeliverableParams }>, reply) =>
    executeRead(reply, () => options.application.readDeliverableContent(request.params.taskId, request.params.deliverableId)),
  );
}

async function executeMutation<TInput extends object>(
  options: TaskStageRouteOptions,
  reply: FastifyReply,
  taskId: string,
  body: WorkManagementMutationRequest<TInput>,
  commandType: WorkManagementCommandType,
  destinationId: string,
  resourceId: string,
  operation: (input: TInput) => Promise<ZeusTaskWorkflowSnapshot> | ZeusTaskWorkflowSnapshot,
): Promise<unknown> {
  try {
    const parsed = options.commands.parse<TInput>({ value: body, commandType, scopeKind: 'task', expectedScopeId: () => taskId });
    const replay = options.commands.replayAcceptedCore<TInput, ZeusTaskWorkflowSnapshot>({ parsed, destinationId, resourceId });
    if (replay) return replay.result;
    const result = await operation(parsed.input);
    const mutation = options.commands.executeCore({ parsed, destinationId, resourceId, mutateBusinessState: () => result });
    await options.save();
    return mutation.result;
  } catch (error) {
    const commandError = workManagementCommandHttpError(error);
    if (commandError) return reply.code(commandError.statusCode).send(commandError.payload);
    const mapped = taskStageApplicationError(error);
    return reply.code(mapped.statusCode).send(mapped.body);
  }
}

async function executeRead(reply: FastifyReply, operation: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const mapped = taskStageApplicationError(error);
    return reply.code(mapped.statusCode).send(mapped.body);
  }
}
