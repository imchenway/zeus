import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TaskStageApplication, taskStageApplicationError, type CaptureTaskStageDeliverableInput, type CreateManualTaskStageDeliverableInput, type InitializeTaskWorkflowInput } from './taskStageApplication.js';
import type { UpdateTaskStageInput } from '@zeus/storage';

type TaskParams = { taskId: string };
type StageParams = TaskParams & { stageId: string };
type DeliverableParams = TaskParams & { deliverableId: string };

/** 任务阶段公开接口保持任务作用域，交付物正文读取仍按专属 Artifact owner 授权。 */
export function registerTaskStageRoutes(options: { server: FastifyInstance; application: TaskStageApplication }): void {
  options.server.get('/api/tasks/:taskId/workflow', async (request: FastifyRequest<{ Params: TaskParams }>, reply) => execute(reply, () => options.application.readWorkflow(request.params.taskId)));

  options.server.post('/api/tasks/:taskId/workflow', async (request: FastifyRequest<{ Params: TaskParams; Body: InitializeTaskWorkflowInput }>, reply) =>
    execute(reply, () => options.application.initializeWorkflow(request.params.taskId, request.body)),
  );

  options.server.patch('/api/tasks/:taskId/workflow/stages/:stageId', async (request: FastifyRequest<{ Params: StageParams; Body: UpdateTaskStageInput }>, reply) =>
    execute(reply, () => options.application.updateStage(request.params.taskId, request.params.stageId, request.body)),
  );

  options.server.post('/api/tasks/:taskId/workflow/stages/:stageId/deliverables/capture', async (request: FastifyRequest<{ Params: StageParams; Body: CaptureTaskStageDeliverableInput }>, reply) =>
    execute(reply, () => options.application.captureLatestConversationOutput(request.params.taskId, request.params.stageId, request.body)),
  );

  options.server.post('/api/tasks/:taskId/workflow/stages/:stageId/deliverables', async (request: FastifyRequest<{ Params: StageParams; Body: CreateManualTaskStageDeliverableInput }>, reply) =>
    execute(reply, () => options.application.createManualDeliverable(request.params.taskId, request.params.stageId, request.body)),
  );

  options.server.post('/api/tasks/:taskId/workflow/stages/:stageId/skip', async (request: FastifyRequest<{ Params: StageParams; Body: { expectedRevision: number; reason: string } }>, reply) =>
    execute(reply, () => options.application.skipStage(request.params.taskId, request.params.stageId, request.body)),
  );

  options.server.post('/api/tasks/:taskId/workflow/deliverables/:deliverableId/accept', async (request: FastifyRequest<{ Params: DeliverableParams; Body: { expectedStageRevision: number } }>, reply) =>
    execute(reply, () => options.application.acceptDeliverable(request.params.taskId, request.params.deliverableId, request.body)),
  );

  options.server.post('/api/tasks/:taskId/workflow/deliverables/:deliverableId/request-changes', async (request: FastifyRequest<{ Params: DeliverableParams; Body: { expectedStageRevision: number; reason: string } }>, reply) =>
    execute(reply, () => options.application.requestChanges(request.params.taskId, request.params.deliverableId, request.body)),
  );

  options.server.get('/api/tasks/:taskId/workflow/deliverables/:deliverableId/content', async (request: FastifyRequest<{ Params: DeliverableParams }>, reply) =>
    execute(reply, () => options.application.readDeliverableContent(request.params.taskId, request.params.deliverableId)),
  );
}

async function execute(reply: FastifyReply, operation: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const mapped = taskStageApplicationError(error);
    return reply.code(mapped.statusCode).send(mapped.body);
  }
}
