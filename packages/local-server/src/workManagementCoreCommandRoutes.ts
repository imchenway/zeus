import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CommandActor, TaskBoardViewUpdateRequest } from '@zeus/shared';
import type { TaskPriority, TaskType } from '@zeus/storage';
import { WorkManagementCommandApplication, WorkManagementCommandApplicationError, type WorkManagementMutationRequest, workManagementCommandHttpError, workManagementCommandTypes } from './workManagementCommandApplication.js';

export interface CreateTaskTemplateInput {
  projectId?: string;
  name: string;
  description: string;
  promptTemplate: string;
  category?: string;
  defaultOptions?: Record<string, unknown>;
}

export interface CreateTaskFromTemplateInput {
  projectId: string;
  title?: string;
  variables?: Record<string, string>;
}

export interface CreateUserTaskInput {
  projectId: string;
  parentTaskId?: string | null;
  title: string;
  taskType?: TaskType;
  description?: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  sourceContext?: Record<string, unknown>;
  tags?: string[];
  priority?: TaskPriority;
  allowCodeChanges?: boolean;
  allowTests?: boolean;
  allowGitCommit?: boolean;
}

export interface CreateTaskFromGraphNodeInput {
  projectId?: string;
  intent?: string;
}

export interface CreateProjectGraphTaskInput {
  intent?: string;
}

export interface LinkGraphNodeInput {
  nodeId?: string;
  reason?: string;
}

export interface CreateTaskFromGraphConversationInput {
  intent?: string;
}

export type WorkManagementCommandActor = CommandActor;

export class WorkManagementRouteError extends Error {
  constructor(
    readonly statusCode: number,
    readonly payload: Record<string, unknown>,
  ) {
    super(typeof payload.message === 'string' ? payload.message : 'Work Management route rejected the command.');
    this.name = 'WorkManagementRouteError';
  }
}

interface CoreRouteContext {
  commandId: string;
  operationIdentity: string;
  actor: WorkManagementCommandActor;
}

export function registerWorkManagementCoreCommandRoutes(options: {
  server: FastifyInstance;
  application: WorkManagementCommandApplication;
  updateTaskBoard(projectId: string, input: TaskBoardViewUpdateRequest, context: CoreRouteContext): unknown;
  retryTask(taskId: string, context: CoreRouteContext): unknown;
  createUserTask(input: CreateUserTaskInput, taskId: string, context: CoreRouteContext): unknown;
  createTaskTemplate(input: CreateTaskTemplateInput, templateId: string, context: CoreRouteContext): unknown;
  createTaskFromTemplate(templateId: string, input: CreateTaskFromTemplateInput, taskId: string, context: CoreRouteContext): unknown;
  createTaskFromGraphConversation(projectId: string, conversationId: string, input: CreateTaskFromGraphConversationInput, taskId: string, context: CoreRouteContext): unknown;
  createTaskFromGraphNode(projectId: string | null, nodeId: string, input: CreateTaskFromGraphNodeInput | CreateProjectGraphTaskInput, taskId: string, context: CoreRouteContext): unknown;
  createTaskFromGraphView(projectId: string, viewId: string, input: CreateProjectGraphTaskInput, taskId: string, context: CoreRouteContext): unknown;
  linkTaskGraphNode(taskId: string, input: LinkGraphNodeInput, context: CoreRouteContext): unknown;
  afterTaskBoardUpdated?(result: unknown): void;
  afterTaskRetried?(result: unknown): void;
}): void {
  options.server.patch('/api/projects/:projectId/task-board', async (request: FastifyRequest<{ Params: { projectId: string }; Body: WorkManagementMutationRequest<TaskBoardViewUpdateRequest> }>, reply) =>
    executeCoreRoute<TaskBoardViewUpdateRequest>({
      application: options.application,
      reply,
      value: request.body,
      commandType: workManagementCommandTypes.taskBoardUpdate,
      scopeKind: 'project',
      expectedScopeId: () => request.params.projectId,
      validateExpectedRevision: (parsed) => parsed.command.expectedRevision === parsed.input.expectedRevision,
      destinationId: 'work-management-task-board-application',
      resourceId: () => request.params.projectId,
      mutate: (parsed) => options.updateTaskBoard(request.params.projectId, parsed.input, contextOf(parsed)),
      afterAccepted: options.afterTaskBoardUpdated,
    }),
  );

  options.server.post('/api/tasks/:taskId/retry', async (request: FastifyRequest<{ Params: { taskId: string }; Body: WorkManagementMutationRequest<Record<string, never>> }>, reply) =>
    executeCoreRoute<Record<string, never>>({
      application: options.application,
      reply,
      value: request.body,
      commandType: workManagementCommandTypes.taskRetry,
      scopeKind: 'task',
      expectedScopeId: () => request.params.taskId,
      validateExpectedRevision: (parsed) => parsed.command.expectedRevision === null,
      destinationId: 'work-management-task-lifecycle-application',
      resourceId: () => request.params.taskId,
      mutate: (parsed) => options.retryTask(request.params.taskId, contextOf(parsed)),
      afterAccepted: options.afterTaskRetried,
    }),
  );

  options.server.post('/api/tasks', async (request: FastifyRequest<{ Body: WorkManagementMutationRequest<CreateUserTaskInput> }>, reply) =>
    executeTaskCreationRoute<CreateUserTaskInput>({
      application: options.application,
      reply,
      value: request.body,
      commandType: workManagementCommandTypes.taskCreate,
      destinationId: 'work-management-task-application',
      mutate: (parsed) => options.createUserTask(parsed.input, parsed.operationIdentity, contextOf(parsed)),
    }),
  );

  options.server.post('/api/task-templates', async (request: FastifyRequest<{ Body: WorkManagementMutationRequest<CreateTaskTemplateInput> }>, reply) =>
    executeCoreRoute<CreateTaskTemplateInput>({
      application: options.application,
      reply,
      value: request.body,
      commandType: workManagementCommandTypes.taskTemplateCreate,
      scopeKind: 'project',
      expectedScopeId: ({ input }) => input.projectId ?? 'global',
      validateExpectedRevision: (parsed) => parsed.command.expectedRevision === null && /^task_template_[0-9a-f]{32}$/u.test(parsed.operationIdentity),
      destinationId: 'work-management-task-template-application',
      resourceId: (parsed) => parsed.operationIdentity,
      successStatusCode: 201,
      mutate: (parsed) => options.createTaskTemplate(parsed.input, parsed.operationIdentity, contextOf(parsed)),
    }),
  );

  options.server.post('/api/task-templates/:templateId/tasks', async (request: FastifyRequest<{ Params: { templateId: string }; Body: WorkManagementMutationRequest<CreateTaskFromTemplateInput> }>, reply) =>
    executeTaskCreationRoute<CreateTaskFromTemplateInput>({
      application: options.application,
      reply,
      value: request.body,
      commandType: workManagementCommandTypes.taskFromTemplateCreate,
      destinationId: 'work-management-task-template-application',
      mutate: (parsed) => options.createTaskFromTemplate(request.params.templateId, parsed.input, parsed.operationIdentity, contextOf(parsed)),
    }),
  );

  options.server.post(
    '/api/projects/:projectId/conversations/:conversationId/tasks',
    async (request: FastifyRequest<{ Params: { projectId: string; conversationId: string }; Body: WorkManagementMutationRequest<CreateTaskFromGraphConversationInput> }>, reply) =>
      executeTaskCreationRoute<CreateTaskFromGraphConversationInput>({
        application: options.application,
        reply,
        value: request.body,
        commandType: workManagementCommandTypes.taskFromGraphConversationCreate,
        destinationId: 'work-management-graph-task-application',
        mutate: (parsed) => options.createTaskFromGraphConversation(request.params.projectId, request.params.conversationId, parsed.input, parsed.operationIdentity, contextOf(parsed)),
      }),
  );

  options.server.post('/api/graph/nodes/:nodeId/tasks', async (request: FastifyRequest<{ Params: { nodeId: string }; Body: WorkManagementMutationRequest<CreateTaskFromGraphNodeInput> }>, reply) =>
    executeTaskCreationRoute<CreateTaskFromGraphNodeInput>({
      application: options.application,
      reply,
      value: request.body,
      commandType: workManagementCommandTypes.taskFromGraphNodeCreate,
      destinationId: 'work-management-graph-task-application',
      mutate: (parsed) => options.createTaskFromGraphNode(parsed.input.projectId ?? null, request.params.nodeId, parsed.input, parsed.operationIdentity, contextOf(parsed)),
    }),
  );

  options.server.post('/api/projects/:projectId/graph/nodes/:nodeId/create-task', async (request: FastifyRequest<{ Params: { projectId: string; nodeId: string }; Body: WorkManagementMutationRequest<CreateProjectGraphTaskInput> }>, reply) =>
    executeTaskCreationRoute<CreateProjectGraphTaskInput>({
      application: options.application,
      reply,
      value: request.body,
      commandType: workManagementCommandTypes.taskFromGraphNodeCreate,
      destinationId: 'work-management-graph-task-application',
      mutate: (parsed) => options.createTaskFromGraphNode(request.params.projectId, request.params.nodeId, parsed.input, parsed.operationIdentity, contextOf(parsed)),
    }),
  );

  options.server.post('/api/projects/:projectId/graph/views/:viewId/create-task', async (request: FastifyRequest<{ Params: { projectId: string; viewId: string }; Body: WorkManagementMutationRequest<CreateProjectGraphTaskInput> }>, reply) =>
    executeTaskCreationRoute<CreateProjectGraphTaskInput>({
      application: options.application,
      reply,
      value: request.body,
      commandType: workManagementCommandTypes.taskFromGraphViewCreate,
      destinationId: 'work-management-graph-task-application',
      mutate: (parsed) => options.createTaskFromGraphView(request.params.projectId, request.params.viewId, parsed.input, parsed.operationIdentity, contextOf(parsed)),
    }),
  );

  options.server.post('/api/tasks/:taskId/link-graph-node', async (request: FastifyRequest<{ Params: { taskId: string }; Body: WorkManagementMutationRequest<LinkGraphNodeInput> }>, reply) =>
    executeCoreRoute<LinkGraphNodeInput>({
      application: options.application,
      reply,
      value: request.body,
      commandType: workManagementCommandTypes.taskGraphNodeLink,
      scopeKind: 'task',
      expectedScopeId: () => request.params.taskId,
      validateExpectedRevision: (parsed) => parsed.command.expectedRevision === null,
      destinationId: 'work-management-graph-task-application',
      resourceId: () => request.params.taskId,
      mutate: (parsed) => options.linkTaskGraphNode(request.params.taskId, parsed.input, contextOf(parsed)),
    }),
  );
}

function executeTaskCreationRoute<TInput extends object>(input: {
  application: WorkManagementCommandApplication;
  reply: FastifyReply;
  value: unknown;
  commandType: (typeof workManagementCommandTypes)[keyof typeof workManagementCommandTypes];
  destinationId: string;
  mutate(parsed: ReturnType<WorkManagementCommandApplication['parse']> & { input: TInput }): unknown;
}) {
  return executeCoreRoute<TInput>({
    ...input,
    scopeKind: 'task',
    expectedScopeId: ({ operationIdentity }) => operationIdentity,
    validateExpectedRevision: (parsed) => parsed.command.expectedRevision === null && /^task_[0-9a-f]{32}$/u.test(parsed.operationIdentity),
    resourceId: (parsed) => parsed.operationIdentity,
    successStatusCode: 201,
  });
}

function executeCoreRoute<TInput extends object>(input: {
  application: WorkManagementCommandApplication;
  reply: FastifyReply;
  value: unknown;
  commandType: (typeof workManagementCommandTypes)[keyof typeof workManagementCommandTypes];
  scopeKind: 'project' | 'task';
  expectedScopeId(parsed: { input: TInput; operationIdentity: string }): string;
  validateExpectedRevision(parsed: ReturnType<WorkManagementCommandApplication['parse']> & { input: TInput }): boolean;
  destinationId: string;
  resourceId(parsed: ReturnType<WorkManagementCommandApplication['parse']> & { input: TInput }): string;
  successStatusCode?: number;
  mutate(parsed: ReturnType<WorkManagementCommandApplication['parse']> & { input: TInput }): unknown;
  afterAccepted?(result: unknown): void;
}) {
  try {
    const parsed = input.application.parse<TInput>({ value: input.value, commandType: input.commandType, scopeKind: input.scopeKind, expectedScopeId: input.expectedScopeId });
    if (!input.validateExpectedRevision(parsed)) throw new WorkManagementCommandApplicationError('ZEUS_WORK_MANAGEMENT_COMMAND_INVALID', 'Command expectedRevision or operation identity is invalid for this route.', 409);
    const resourceId = input.resourceId(parsed);
    const replay = input.application.replayAcceptedCore<TInput, unknown>({ parsed, destinationId: input.destinationId, resourceId });
    if (replay) return input.successStatusCode ? input.reply.code(input.successStatusCode).send(replay.result) : replay.result;
    const mutation = input.application.executeCore({ parsed, destinationId: input.destinationId, resourceId, mutateBusinessState: () => input.mutate(parsed) });
    if (!mutation.replayed) input.afterAccepted?.(mutation.result);
    return input.successStatusCode ? input.reply.code(input.successStatusCode).send(mutation.result) : mutation.result;
  } catch (error) {
    if (error instanceof WorkManagementRouteError) return input.reply.code(error.statusCode).send(error.payload);
    const mapped = workManagementCommandHttpError(error);
    if (mapped) return input.reply.code(mapped.statusCode).send(mapped.payload);
    throw error;
  }
}

function contextOf(parsed: ReturnType<WorkManagementCommandApplication['parse']>): CoreRouteContext {
  return { commandId: parsed.command.commandId, operationIdentity: parsed.operationIdentity, actor: parsed.command.actor };
}
