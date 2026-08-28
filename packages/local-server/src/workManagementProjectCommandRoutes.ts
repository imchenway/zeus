import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  type ParsedWorkManagementMutation,
  WorkManagementCommandApplication,
  WorkManagementCommandApplicationError,
  type WorkManagementCommandType,
  type WorkManagementMutationRequest,
  workManagementCommandHttpError,
  workManagementCommandTypes,
} from './workManagementCommandApplication.js';
import { WorkManagementRouteError } from './workManagementCoreCommandRoutes.js';
import type { CreateProjectCommandInput, SetProjectDefaultTemplateCommandInput, UpdateProjectCommandInput, UpdateProjectWorkspaceCommandInput } from './workManagementProjectOperations.js';
import type { WorkManagementTaskCommandContext } from './workManagementTaskCommandRoutes.js';

type ErrorMapping = { statusCode: number; payload: Record<string, unknown> };

/** Project HTTP 层只验证命令信封、映射状态码并调用单一项目应用端口。 */
export function registerWorkManagementProjectCommandRoutes(options: {
  server: FastifyInstance;
  application: WorkManagementCommandApplication;
  create(input: CreateProjectCommandInput, projectId: string, context: WorkManagementTaskCommandContext): unknown;
  update(projectId: string, input: UpdateProjectCommandInput, context: WorkManagementTaskCommandContext): unknown;
  updateWorkspace(projectId: string, input: UpdateProjectWorkspaceCommandInput, context: WorkManagementTaskCommandContext): unknown;
  remove(projectId: string, context: WorkManagementTaskCommandContext): unknown;
  archiveConfirmation(projectId: string): unknown;
  archive(projectId: string): unknown;
  restore(projectId: string): unknown;
  setDefaultTemplate(projectId: string, input: SetProjectDefaultTemplateCommandInput): unknown;
  mapDomainError?(error: unknown): ErrorMapping | null;
}): void {
  options.server.post('/api/projects', async (request: FastifyRequest<{ Body: WorkManagementMutationRequest<CreateProjectCommandInput> }>, reply) => {
    try {
      const parsed = options.application.parse<CreateProjectCommandInput>({
        value: request.body,
        commandType: workManagementCommandTypes.projectCreate,
        scopeKind: 'project',
        expectedScopeId: ({ operationIdentity }) => operationIdentity,
      });
      if (parsed.command.expectedRevision !== null || !/^project_[A-Za-z0-9-]{16,160}$/u.test(parsed.operationIdentity)) {
        throw new WorkManagementCommandApplicationError('ZEUS_WORK_MANAGEMENT_COMMAND_INVALID', 'Project create requires expectedRevision=null and a stable project operation identity.', 409);
      }
      const replay = options.application.replayAcceptedCore<CreateProjectCommandInput, unknown>({ parsed, destinationId: projectDestinationId, resourceId: parsed.operationIdentity });
      if (replay) return reply.code(201).send(replay.result);
      const result = options.application.executeCore({
        parsed,
        destinationId: projectDestinationId,
        resourceId: parsed.operationIdentity,
        mutateBusinessState: () => options.create(parsed.input, parsed.operationIdentity, contextOf(parsed)),
      }).result;
      return reply.code(201).send(result);
    } catch (error) {
      return sendError(reply, error, options.mapDomainError);
    }
  });

  registerProjectMutation(options, 'patch', '/api/projects/:projectId', workManagementCommandTypes.projectUpdate, (projectId, input, context) => options.update(projectId, input as UpdateProjectCommandInput, context));
  registerProjectMutation(options, 'put', '/api/projects/:projectId/workspace-config', workManagementCommandTypes.projectWorkspaceUpdate, (projectId, input, context) =>
    options.updateWorkspace(projectId, input as UpdateProjectWorkspaceCommandInput, context),
  );
  registerProjectMutation(options, 'delete', '/api/projects/:projectId', workManagementCommandTypes.projectDelete, (projectId, _input, context) => options.remove(projectId, context));
  registerProjectMutation(options, 'post', '/api/projects/:projectId/archive', workManagementCommandTypes.projectArchive, (projectId) => options.archive(projectId));
  registerProjectMutation(options, 'post', '/api/projects/:projectId/restore', workManagementCommandTypes.projectRestore, (projectId) => options.restore(projectId));
  registerProjectMutation(options, 'put', '/api/projects/:projectId/default-template', workManagementCommandTypes.projectDefaultTemplateSet, (projectId, input) =>
    options.setDefaultTemplate(projectId, input as SetProjectDefaultTemplateCommandInput),
  );

  options.server.post('/api/projects/:projectId/archive-confirmation', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    try {
      return options.archiveConfirmation(request.params.projectId);
    } catch (error) {
      return sendError(reply, error, options.mapDomainError);
    }
  });
}

function registerProjectMutation(
  options: {
    server: FastifyInstance;
    application: WorkManagementCommandApplication;
    mapDomainError?(error: unknown): ErrorMapping | null;
  },
  method: 'post' | 'patch' | 'put' | 'delete',
  path: string,
  commandType: WorkManagementCommandType,
  mutate: (projectId: string, input: object, context: WorkManagementTaskCommandContext) => unknown,
): void {
  options.server[method](path, async (request: FastifyRequest<{ Params: { projectId: string }; Body: WorkManagementMutationRequest<object> }>, reply) => {
    try {
      const parsed = options.application.parse<object>({ value: request.body, commandType, scopeKind: 'project', expectedScopeId: () => request.params.projectId });
      if (parsed.command.expectedRevision !== null) throw new WorkManagementCommandApplicationError('ZEUS_WORK_MANAGEMENT_COMMAND_INVALID', `${commandType} currently requires expectedRevision=null.`, 409);
      const replay = options.application.replayAcceptedCore<object, unknown>({ parsed, destinationId: projectDestinationId, resourceId: request.params.projectId });
      if (replay) return replay.result;
      return options.application.executeCore({
        parsed,
        destinationId: projectDestinationId,
        resourceId: request.params.projectId,
        mutateBusinessState: () => mutate(request.params.projectId, parsed.input, contextOf(parsed)),
      }).result;
    } catch (error) {
      return sendError(reply, error, options.mapDomainError);
    }
  });
}

function contextOf(parsed: ParsedWorkManagementMutation<object>): WorkManagementTaskCommandContext {
  return { commandId: parsed.command.commandId, operationIdentity: parsed.operationIdentity, actor: parsed.command.actor };
}

function sendError(reply: FastifyReply, error: unknown, mapDomainError?: (error: unknown) => ErrorMapping | null): unknown {
  if (error instanceof WorkManagementRouteError) return reply.code(error.statusCode).send(error.payload);
  const commandError = workManagementCommandHttpError(error);
  if (commandError) return reply.code(commandError.statusCode).send(commandError.payload);
  const domainError = mapDomainError?.(error);
  if (domainError) return reply.code(domainError.statusCode).send(domainError.payload);
  throw error;
}

const projectDestinationId = 'work-management-project-application';
