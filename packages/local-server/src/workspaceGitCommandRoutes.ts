import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  WorkspaceGitCommandApplication,
  workspaceGitCommandHttpError,
  workspaceGitCommandTypes,
  type ParsedWorkspaceGitMutation,
  type WorkspaceGitCommandType,
  type WorkspaceGitMutationRequest,
  type WorkspaceGitScopeKind,
} from './workspaceGitCommandApplication.js';

type ProjectParams = { projectId: string };
type ProjectRepositoryParams = ProjectParams & { repositoryId: string };
type TaskParams = { taskId: string };
type TaskWorkspaceParams = TaskParams & { workspaceId: string };
type TaskIntegrationParams = TaskParams & { integrationId: string };
type EmptyInput = Record<string, never>;

export const workspaceGitCommandRoutePolicy = {
  externalOperations: [
    'POST /api/projects/:projectId/git/workbench/repositories/:repositoryId/actions',
    'POST /api/tasks/:taskId/git-workspaces/commit-all',
    'POST /api/tasks/:taskId/git-workspaces/push-all',
    'POST /api/tasks/:taskId/git-workspaces/:workspaceId/commit',
    'POST /api/tasks/:taskId/git-workspaces/:workspaceId/push',
    'POST /api/tasks/:taskId/git-workspaces/:workspaceId/stop-sessions',
    'POST /api/tasks/:taskId/git-workspaces/:workspaceId/reclaim',
    'POST /api/tasks/:taskId/git-workspaces/:workspaceId/discard',
    'POST /api/tasks/:taskId/git-workspaces/:workspaceId/integrate',
    'POST /api/tasks/:taskId/integrations/:integrationId/conflict/ai-session',
    'PUT /api/tasks/:taskId/integrations/:integrationId/conflict',
    'POST /api/tasks/:taskId/integrations/:integrationId/finalize',
    'POST /api/tasks/:taskId/integrations/:integrationId/push',
    'POST /api/projects/:projectId/git/snapshot',
    'POST /api/projects/:projectId/git/patch',
    'POST /api/projects/:projectId/codex-task-push-capabilities/repositories/:repositoryId/refresh-remote',
  ],
  externalIdentity: 'workspace-git-command-operation-identity',
  acceptedResult: 'immutable-artifact-ref',
  postWriteFailure: 'outcome_unknown_after_write',
  automaticRetryAfterUnknown: false,
} as const;

export interface PreparedWorkspaceGitCommand {
  destinationId: string;
  resourceId: string;
  externalOperationId: string;
  opaque: unknown;
}

export interface WorkspaceGitRouteResult {
  statusCode: number;
  body: unknown;
}

export interface WorkspaceGitRouteExecution {
  response: WorkspaceGitRouteResult;
  /** 只允许同步写 Core SQLite；Application 会与 accepted receipt 放入同一事务。 */
  commitAccepted?(): void;
}

export interface WorkspaceGitCommandRouteOperations {
  prepare(input: {
    commandType: WorkspaceGitCommandType;
    operationIdentity: string;
    projectId?: string;
    taskId?: string;
    repositoryId?: string;
    workspaceId?: string;
    integrationId?: string;
    value: Record<string, unknown>;
  }): Promise<PreparedWorkspaceGitCommand>;
  execute(input: { commandType: WorkspaceGitCommandType; operationIdentity: string; prepared: PreparedWorkspaceGitCommand; value: Record<string, unknown> }): Promise<WorkspaceGitRouteExecution>;
  isExplicitRejection(error: unknown): boolean;
}

/** 注册剩余 Project Workbench、Task Workspace/Integration 与 task-push Git mutation。 */
export function registerWorkspaceGitCommandRoutes(options: {
  server: FastifyInstance;
  application: WorkspaceGitCommandApplication;
  operations: WorkspaceGitCommandRouteOperations;
  sendError(reply: FastifyReply, error: unknown): unknown;
}): void {
  const { server } = options;

  server.post('/api/projects/:projectId/git/workbench/repositories/:repositoryId/actions', async (request: FastifyRequest<{ Params: ProjectRepositoryParams; Body: WorkspaceGitMutationRequest<Record<string, unknown>> }>, reply) =>
    execute(request, reply, {
      commandType: workspaceGitCommandTypes.workbenchAction,
      scopeKind: 'git_repository',
      scopeId: request.params.repositoryId,
      ids: request.params,
      allowedInputKeys: ['baseRef', 'branchName', 'forceWithLease', 'includeUntracked', 'message', 'paths', 'pop', 'pushTags', 'remote', 'revision', 'smart', 'stashRef', 'strategy', 'targetBranch', 'trackRemote', 'type'],
    }),
  );

  server.post('/api/tasks/:taskId/git-workspaces/commit-all', async (request: FastifyRequest<{ Params: TaskParams; Body: WorkspaceGitMutationRequest<{ message?: unknown }> }>, reply) =>
    execute(request, reply, {
      commandType: workspaceGitCommandTypes.taskWorkspaceCommitAll,
      scopeKind: 'task',
      scopeId: request.params.taskId,
      ids: request.params,
      allowedInputKeys: ['message'],
    }),
  );

  server.post('/api/tasks/:taskId/git-workspaces/push-all', async (request: FastifyRequest<{ Params: TaskParams; Body: WorkspaceGitMutationRequest<EmptyInput> }>, reply) =>
    execute(request, reply, {
      commandType: workspaceGitCommandTypes.taskWorkspacePushAll,
      scopeKind: 'task',
      scopeId: request.params.taskId,
      ids: request.params,
      allowedInputKeys: [],
    }),
  );

  server.post('/api/tasks/:taskId/git-workspaces/:workspaceId/commit', async (request: FastifyRequest<{ Params: TaskWorkspaceParams; Body: WorkspaceGitMutationRequest<{ message?: unknown; selectedPaths?: unknown }> }>, reply) =>
    execute(request, reply, {
      commandType: workspaceGitCommandTypes.taskWorkspaceCommit,
      scopeKind: 'task_workspace',
      scopeId: request.params.workspaceId,
      ids: request.params,
      allowedInputKeys: ['message', 'selectedPaths'],
    }),
  );

  server.post('/api/tasks/:taskId/git-workspaces/:workspaceId/push', async (request: FastifyRequest<{ Params: TaskWorkspaceParams; Body: WorkspaceGitMutationRequest<EmptyInput> }>, reply) =>
    execute(request, reply, {
      commandType: workspaceGitCommandTypes.taskWorkspacePush,
      scopeKind: 'task_workspace',
      scopeId: request.params.workspaceId,
      ids: request.params,
      allowedInputKeys: [],
    }),
  );

  server.post('/api/tasks/:taskId/git-workspaces/:workspaceId/stop-sessions', async (request: FastifyRequest<{ Params: TaskWorkspaceParams; Body: WorkspaceGitMutationRequest<EmptyInput> }>, reply) =>
    execute(request, reply, {
      commandType: workspaceGitCommandTypes.taskWorkspaceStopSessions,
      scopeKind: 'task_workspace',
      scopeId: request.params.workspaceId,
      ids: request.params,
      allowedInputKeys: [],
    }),
  );

  server.post('/api/tasks/:taskId/git-workspaces/:workspaceId/reclaim', async (request: FastifyRequest<{ Params: TaskWorkspaceParams; Body: WorkspaceGitMutationRequest<EmptyInput> }>, reply) =>
    execute(request, reply, {
      commandType: workspaceGitCommandTypes.taskWorkspaceReclaim,
      scopeKind: 'task_workspace',
      scopeId: request.params.workspaceId,
      ids: request.params,
      allowedInputKeys: [],
    }),
  );

  server.post('/api/tasks/:taskId/git-workspaces/:workspaceId/discard', async (request: FastifyRequest<{ Params: TaskWorkspaceParams; Body: WorkspaceGitMutationRequest<{ confirmationText?: unknown }> }>, reply) =>
    execute(request, reply, {
      commandType: workspaceGitCommandTypes.taskWorkspaceDiscard,
      scopeKind: 'task_workspace',
      scopeId: request.params.workspaceId,
      ids: request.params,
      allowedInputKeys: ['confirmationText'],
    }),
  );

  server.post(
    '/api/tasks/:taskId/git-workspaces/:workspaceId/integrate',
    async (request: FastifyRequest<{ Params: TaskWorkspaceParams; Body: WorkspaceGitMutationRequest<{ targetBranch?: unknown; mode?: unknown; prepareOnly?: unknown }> }>, reply) =>
      execute(request, reply, {
        commandType: workspaceGitCommandTypes.taskWorkspaceIntegrate,
        scopeKind: 'task_workspace',
        scopeId: request.params.workspaceId,
        ids: request.params,
        allowedInputKeys: ['mode', 'prepareOnly', 'targetBranch'],
      }),
  );

  server.post(
    '/api/tasks/:taskId/integrations/:integrationId/conflict/ai-session',
    async (
      request: FastifyRequest<{
        Params: TaskIntegrationParams;
        Body: WorkspaceGitMutationRequest<{ path?: unknown; content?: unknown; fingerprint?: unknown; permissionMode?: unknown; skillId?: unknown }>;
      }>,
      reply,
    ) =>
      execute(request, reply, {
        commandType: workspaceGitCommandTypes.taskIntegrationConflictAiSession,
        scopeKind: 'task_integration',
        scopeId: request.params.integrationId,
        ids: request.params,
        allowedInputKeys: ['content', 'fingerprint', 'path', 'permissionMode', 'skillId'],
      }),
  );

  server.put('/api/tasks/:taskId/integrations/:integrationId/conflict', async (request: FastifyRequest<{ Params: TaskIntegrationParams; Body: WorkspaceGitMutationRequest<{ path?: unknown; content?: unknown }> }>, reply) =>
    execute(request, reply, {
      commandType: workspaceGitCommandTypes.taskIntegrationConflictResolve,
      scopeKind: 'task_integration',
      scopeId: request.params.integrationId,
      ids: request.params,
      allowedInputKeys: ['content', 'path'],
    }),
  );

  server.post('/api/tasks/:taskId/integrations/:integrationId/finalize', async (request: FastifyRequest<{ Params: TaskIntegrationParams; Body: WorkspaceGitMutationRequest<EmptyInput> }>, reply) =>
    execute(request, reply, {
      commandType: workspaceGitCommandTypes.taskIntegrationFinalize,
      scopeKind: 'task_integration',
      scopeId: request.params.integrationId,
      ids: request.params,
      allowedInputKeys: [],
    }),
  );

  server.post('/api/tasks/:taskId/integrations/:integrationId/push', async (request: FastifyRequest<{ Params: TaskIntegrationParams; Body: WorkspaceGitMutationRequest<EmptyInput> }>, reply) =>
    execute(request, reply, {
      commandType: workspaceGitCommandTypes.taskIntegrationPush,
      scopeKind: 'task_integration',
      scopeId: request.params.integrationId,
      ids: request.params,
      allowedInputKeys: [],
    }),
  );

  server.post('/api/projects/:projectId/git/snapshot', async (request: FastifyRequest<{ Params: ProjectParams; Body: WorkspaceGitMutationRequest<{ taskId?: unknown }> }>, reply) =>
    execute(request, reply, {
      commandType: workspaceGitCommandTypes.projectSnapshotCreate,
      scopeKind: 'git_repository',
      scopeId: `project:${request.params.projectId}`,
      ids: request.params,
      allowedInputKeys: ['taskId'],
    }),
  );

  server.post('/api/projects/:projectId/git/patch', async (request: FastifyRequest<{ Params: ProjectParams; Body: WorkspaceGitMutationRequest<EmptyInput> }>, reply) =>
    execute(request, reply, {
      commandType: workspaceGitCommandTypes.projectPatchExport,
      scopeKind: 'git_repository',
      scopeId: `project:${request.params.projectId}`,
      ids: request.params,
      allowedInputKeys: [],
    }),
  );

  server.post(
    '/api/projects/:projectId/codex-task-push-capabilities/repositories/:repositoryId/refresh-remote',
    async (request: FastifyRequest<{ Params: ProjectRepositoryParams; Body: WorkspaceGitMutationRequest<{ taskId?: unknown }> }>, reply) =>
      execute(request, reply, {
        commandType: workspaceGitCommandTypes.taskPushRepositoryRefreshRemote,
        scopeKind: 'git_repository',
        scopeId: request.params.repositoryId,
        ids: request.params,
        allowedInputKeys: ['taskId'],
      }),
  );

  async function execute<TParams extends Record<string, string>, TInput extends object>(
    request: FastifyRequest<{ Params: TParams; Body: WorkspaceGitMutationRequest<TInput> }>,
    reply: FastifyReply,
    route: {
      commandType: WorkspaceGitCommandType;
      scopeKind: WorkspaceGitScopeKind;
      scopeId: string;
      ids: TParams;
      allowedInputKeys: readonly string[];
    },
  ): Promise<unknown> {
    try {
      const parsed = options.application.parse<TInput>({ value: request.body, commandType: route.commandType, scopeKind: route.scopeKind, scopeId: route.scopeId });
      assertOnlyInputKeys(parsed.input, route.allowedInputKeys, route.commandType);
      const ids = route.ids as Record<string, string>;
      const prepared = await options.operations.prepare({
        commandType: route.commandType,
        operationIdentity: parsed.operationIdentity,
        ...(ids.projectId ? { projectId: ids.projectId } : {}),
        ...(ids.taskId ? { taskId: ids.taskId } : {}),
        ...(ids.repositoryId ? { repositoryId: ids.repositoryId } : {}),
        ...(ids.workspaceId ? { workspaceId: ids.workspaceId } : {}),
        ...(ids.integrationId ? { integrationId: ids.integrationId } : {}),
        value: parsed.input as Record<string, unknown>,
      });
      const executed = await executePrepared(parsed, prepared);
      return reply.code(executed.result.statusCode).send(executed.result.body);
    } catch (error) {
      const mapped = workspaceGitCommandHttpError(error);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.payload);
      return options.sendError(reply, error);
    }
  }

  function executePrepared<TInput extends object>(parsed: ParsedWorkspaceGitMutation<TInput>, prepared: PreparedWorkspaceGitCommand) {
    let commitAccepted: (() => void) | undefined;
    return options.application.executeExternal({
      parsed,
      destinationId: prepared.destinationId,
      resourceId: prepared.resourceId,
      externalOperationId: prepared.externalOperationId,
      invoke: async () => {
        const execution = await options.operations.execute({
          commandType: parsed.command.commandType as WorkspaceGitCommandType,
          operationIdentity: parsed.operationIdentity,
          prepared,
          value: parsed.input as Record<string, unknown>,
        });
        commitAccepted = execution.commitAccepted;
        return execution.response;
      },
      mutateAcceptedBusinessState: () => commitAccepted?.(),
      isExplicitRejection: options.operations.isExplicitRejection,
    });
  }
}

function assertOnlyInputKeys(value: object, allowed: readonly string[], commandType: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length === 0) return;
  throw Object.assign(new Error(`${commandType} input contains unsupported fields: ${unexpected.join(', ')}.`), { code: 'ZEUS_WORKSPACE_GIT_COMMAND_INVALID', statusCode: 400 });
}
