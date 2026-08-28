import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type {
    ConversationCollaborationMode,
    ConversationGoalRepository,
    ConversationNextTurnSettings,
    ConversationPermissionMode,
    ConversationRepository,
    ProjectRepository,
    TaskRepository,
    ZeusConversationGoalRecord,
    ZeusConversationRecord,
    ZeusConversationWithMessagesRecord,
    ZeusTaskRecord,
} from '@zeus/storage';
import {
    ConversationCommandApplication,
    ConversationCommandApplicationError,
    conversationCommandHttpError,
    conversationCommandTypes,
    type ConversationMutationRequest,
    type ParsedConversationMutation,
} from './conversationCommandApplication.js';

type EmptyInput = Record<string, never>;

interface NextTurnSettingsInput {
  model?: unknown;
  effort?: unknown;
  serviceTier?: unknown;
  permissionMode?: unknown;
  collaborationMode?: unknown;
}

interface PermissionModeInput {
  permissionMode?: unknown;
}

interface CollaborationModeInput {
  collaborationMode?: unknown;
}

interface GoalSetInput {
  objective?: unknown;
}

interface GoalClearInput {
  confirmUnfinished?: unknown;
}

interface AttentionAcknowledgeInput {
  expectedRevision?: unknown;
}

interface GoalClearResult {
  cleared: boolean;
}

interface ConversationLifecycleResult {
  conversationId: string;
  archived: boolean;
  updatedAt: string;
}

interface ProviderThreadRestoreResult {
  conversationId: string;
  providerThreadId: string | null;
  providerState: string;
}

interface AppendConversationAuditInput {
  actorType: 'local_api';
  action: 'conversation.archived' | 'conversation.restored';
  resourceType: 'conversation';
  resourceId: string;
  payload: { projectId: string; conversationId: string };
}

/** 只注册本批 Conversation 配置与生命周期命令；消息、队列、interrupt 等边界不在此模块。 */
export function registerConversationCommandRoutes(options: {
  server: FastifyInstance;
  application: ConversationCommandApplication;
  projects: Pick<ProjectRepository, 'getById'>;
  tasks: Pick<TaskRepository, 'getById'>;
  conversations: Pick<
    ConversationRepository,
    'getById' | 'getRecordById' | 'getNextTurnSettings' | 'setSessionFileEditGrant' | 'updateNextTurnSettings' | 'updatePermissionMode' | 'updateCollaborationMode' | 'acknowledgeAttention' | 'archive' | 'restore'
  >;
  goals: Pick<ConversationGoalRepository, 'get' | 'listEvents'>;
  codex: {
    readGoal(input: { conversationId: string }): Promise<ZeusConversationGoalRecord | null>;
    setGoal(input: { conversationId: string; objective: string }): Promise<ZeusConversationGoalRecord>;
    pauseGoal(input: { conversationId: string }): Promise<ZeusConversationGoalRecord>;
    resumeGoal(input: { conversationId: string }): Promise<ZeusConversationGoalRecord>;
    clearGoal(input: { conversationId: string }): Promise<GoalClearResult>;
    restoreArchivedConversation(input: { conversationId: string }): Promise<unknown>;
  };
  archiveNativeConversation(conversation: ZeusConversationRecord): Promise<void>;
  restoreNativeConversation(conversation: ZeusConversationRecord): Promise<void>;
  isConversationIdle(conversation: ZeusConversationRecord): boolean;
  isTaskTerminal(task: ZeusTaskRecord): boolean;
  goalCapability(conversation: ZeusConversationRecord): unknown;
  toConversationChoice(conversation: ZeusConversationWithMessagesRecord): unknown;
  toConversationHistoryItem(conversation: ZeusConversationWithMessagesRecord): unknown;
  appendAuditLog(input: AppendConversationAuditInput): void;
  publishNativeEvent(type: string, payload: Record<string, unknown>): void;
  sendNativeError(reply: FastifyReply, error: unknown): unknown;
}): void {
  const { server, application } = options;
  const sendRouteError = (reply: FastifyReply, error: unknown): unknown => {
    const commandError = conversationCommandHttpError(error);
    if (commandError) return reply.code(commandError.statusCode).send(commandError.payload);
    if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && typeof (error as { statusCode?: unknown }).statusCode === 'number') {
      return reply.code((error as { statusCode: number }).statusCode).send({ error: (error as { code: string }).code, message: error instanceof Error ? error.message : String(error) });
    }
    return options.sendNativeError(reply, error);
  };

  server.patch('/api/projects/:projectId/conversations/:conversationId/next-turn-settings', async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationMutationRequest<NextTurnSettingsInput> }>, reply) => {
    try {
      const parsed = parseCommand(request, conversationCommandTypes.nextTurnSettingsUpdate);
      assertExpectedRevision(parsed, null);
      assertOnlyInputKeys(parsed.input, ['model', 'effort', 'serviceTier', 'permissionMode', 'collaborationMode'], parsed.command.commandType);
      const settings = parseNextTurnSettings(parsed.input);
      const mutation = application.executeCore({
        parsed,
        destinationId: 'conversation-settings-application',
        resourceId: request.params.conversationId,
        mutateBusinessState: () => {
          const conversation = requireNativeConversation(request.params, true);
          const previousPermissionMode = options.conversations.getNextTurnSettings(conversation.id)?.permissionMode ?? conversation.permissionMode;
          if (previousPermissionMode !== settings.permissionMode) options.conversations.setSessionFileEditGrant(conversation.id, conversation.projectId, false);
          options.conversations.updateNextTurnSettings(conversation.id, settings);
          return settings;
        },
      });
      return mutation.result;
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.patch('/api/projects/:projectId/conversations/:conversationId/permission-mode', async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationMutationRequest<PermissionModeInput> }>, reply) => {
    try {
      const parsed = parseCommand(request, conversationCommandTypes.permissionModeUpdate);
      assertExpectedRevision(parsed, null);
      assertExactInputKeys(parsed.input, ['permissionMode'], parsed.command.commandType);
      const permissionMode = parsePermissionMode(parsed.input.permissionMode);
      application.executeCore({
        parsed,
        destinationId: 'conversation-settings-application',
        resourceId: request.params.conversationId,
        mutateBusinessState: () => {
          const conversation = requireNativeConversation(request.params, false);
          if (!options.isConversationIdle(conversation)) throw routeError('ZEUS_NATIVE_PERMISSION_MODE_IN_PROGRESS', 'Conversation permission mode can change only while the conversation is idle.', 409);
          if (conversation.permissionMode !== permissionMode) options.conversations.setSessionFileEditGrant(conversation.id, conversation.projectId, false);
          options.conversations.updatePermissionMode(conversation.id, permissionMode);
          return { acknowledged: true as const, permissionMode };
        },
      });
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.patch('/api/projects/:projectId/conversations/:conversationId/collaboration-mode', async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationMutationRequest<CollaborationModeInput> }>, reply) => {
    try {
      const parsed = parseCommand(request, conversationCommandTypes.collaborationModeUpdate);
      assertExpectedRevision(parsed, null);
      assertExactInputKeys(parsed.input, ['collaborationMode'], parsed.command.commandType);
      const collaborationMode = parseCollaborationMode(parsed.input.collaborationMode);
      application.executeCore({
        parsed,
        destinationId: 'conversation-settings-application',
        resourceId: request.params.conversationId,
        mutateBusinessState: () => {
          const conversation = requireNativeConversation(request.params, false);
          options.conversations.updateCollaborationMode(conversation.id, collaborationMode);
          options.publishNativeEvent('conversation.collaboration_mode.changed', { conversationId: conversation.id, collaborationMode });
          return { acknowledged: true as const, collaborationMode };
        },
      });
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.put('/api/projects/:projectId/conversations/:conversationId/goal', async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationMutationRequest<GoalSetInput> }>, reply) => {
    try {
      const parsed = parseCommand(request, conversationCommandTypes.goalSet);
      assertExpectedRevision(parsed, null);
      assertExactInputKeys(parsed.input, ['objective'], parsed.command.commandType);
      const objective = parseGoalObjective(parsed.input.objective);
      const conversation = requireNativeConversation(request.params, false);
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'conversation-provider-goal',
        resourceId: conversation.id,
        invoke: () => options.codex.setGoal({ conversationId: conversation.id, objective }),
      });
      return goalResponse(conversation, executed.result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  for (const action of ['pause', 'resume'] as const) {
    server.post(`/api/projects/:projectId/conversations/:conversationId/goal/${action}`, async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationMutationRequest<EmptyInput> }>, reply) => {
      try {
        const parsed = parseCommand(request, action === 'pause' ? conversationCommandTypes.goalPause : conversationCommandTypes.goalResume);
        assertExpectedRevision(parsed, null);
        assertExactInputKeys(parsed.input, [], parsed.command.commandType);
        const conversation = requireNativeConversation(request.params, false);
        const executed = await application.executeExternal({
          parsed,
          destinationId: 'conversation-provider-goal',
          resourceId: conversation.id,
          invoke: () => (action === 'pause' ? options.codex.pauseGoal({ conversationId: conversation.id }) : options.codex.resumeGoal({ conversationId: conversation.id })),
        });
        return goalResponse(conversation, executed.result);
      } catch (error) {
        return sendRouteError(reply, error);
      }
    });
  }

  server.delete('/api/projects/:projectId/conversations/:conversationId/goal', async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationMutationRequest<GoalClearInput> }>, reply) => {
    try {
      const parsed = parseCommand(request, conversationCommandTypes.goalClear);
      assertExpectedRevision(parsed, null);
      assertExactInputKeys(parsed.input, ['confirmUnfinished'], parsed.command.commandType);
      if (typeof parsed.input.confirmUnfinished !== 'boolean') throw routeError('ZEUS_CONVERSATION_COMMAND_INVALID', 'confirmUnfinished must be a boolean.', 400);
      const conversation = requireNativeConversation(request.params, false);
      const executed = await application.executeExternal({
        parsed,
        destinationId: 'conversation-provider-goal',
        resourceId: conversation.id,
        beforeWrite: async () => {
          const current = await options.codex.readGoal({ conversationId: conversation.id });
          if (current && current.status !== 'complete' && parsed.input.confirmUnfinished !== true) {
            throw routeError('ZEUS_CODEX_GOAL_CLEAR_CONFIRMATION_REQUIRED', '清除未完成目标前必须确认。', 409);
          }
        },
        invoke: () => options.codex.clearGoal({ conversationId: conversation.id }),
      });
      return { ...executed.result, goal: null, timeline: options.goals.listEvents(conversation.id), capability: options.goalCapability(conversation) };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.put('/api/projects/:projectId/conversations/:conversationId/attention-acknowledgement', async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationMutationRequest<AttentionAcknowledgeInput> }>, reply) => {
    try {
      const parsed = parseCommand(request, conversationCommandTypes.attentionAcknowledge);
      assertExactInputKeys(parsed.input, ['expectedRevision'], parsed.command.commandType);
      const expectedRevision = parsed.input.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) throw routeError('ZEUS_INVALID_ATTENTION_REVISION', 'expectedRevision must be a non-negative safe integer.', 400);
      assertExpectedRevision(parsed, expectedRevision as number);
      const mutation = application.executeCore({
        parsed,
        destinationId: 'conversation-attention-application',
        resourceId: request.params.conversationId,
        mutateBusinessState: () => {
          const conversation = requireNativeConversation(request.params, false);
          const result = options.conversations.acknowledgeAttention(conversation.id, expectedRevision as number);
          if (result.acknowledged) {
            options.publishNativeEvent('conversation.attention.acknowledged', {
              conversationId: conversation.id,
              attentionRevision: result.conversation.attentionRevision,
            });
          }
          return { acknowledged: result.acknowledged, attentionRevision: result.conversation.attentionRevision };
        },
      });
      const current = options.conversations.getById(request.params.conversationId);
      if (!current) throw notFound('ZEUS_NATIVE_CONVERSATION_NOT_FOUND', 'Native conversation not found');
      return { acknowledged: mutation.result.acknowledged, conversation: options.toConversationChoice(current) };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.post('/api/projects/:projectId/conversations/:conversationId/provider-thread/restore', async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationMutationRequest<EmptyInput> }>, reply) => {
    try {
      const parsed = parseCommand(request, conversationCommandTypes.providerThreadRestore);
      assertExpectedRevision(parsed, null);
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      const conversation = requireNativeConversation(request.params, false);
      await application.executeExternal({
        parsed,
        destinationId: 'conversation-provider-thread',
        resourceId: conversation.id,
        beforeWrite: async () => assertTaskCanRestore(conversation),
        invoke: async (): Promise<ProviderThreadRestoreResult> => {
          await options.codex.restoreArchivedConversation({ conversationId: conversation.id });
          const restored = options.conversations.getRecordById(conversation.id);
          if (!restored) throw notFound('ZEUS_NATIVE_CONVERSATION_NOT_FOUND', 'Native conversation not found');
          return { conversationId: restored.id, providerThreadId: restored.providerThreadId, providerState: restored.providerState };
        },
        mutateAcceptedBusinessState: (restored) => {
          options.publishNativeEvent('conversation.thread.changed', { ...restored });
          options.publishNativeEvent('conversation.queue.changed', { conversationId: restored.conversationId });
        },
      });
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  server.post('/api/projects/:projectId/conversations/:conversationId/archive', async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationMutationRequest<EmptyInput> }>, reply) => {
    return executeLifecycle(request, reply, 'archive');
  });

  server.post('/api/projects/:projectId/conversations/:conversationId/restore', async (request: FastifyRequest<{ Params: ConversationParams; Body: ConversationMutationRequest<EmptyInput> }>, reply) => {
    return executeLifecycle(request, reply, 'restore');
  });

  async function executeLifecycle(request: FastifyRequest<{ Params: ConversationParams; Body: ConversationMutationRequest<EmptyInput> }>, reply: FastifyReply, action: 'archive' | 'restore') {
    try {
      const parsed = parseCommand(request, action === 'archive' ? conversationCommandTypes.archive : conversationCommandTypes.restore);
      assertExpectedRevision(parsed, null);
      assertExactInputKeys(parsed.input, [], parsed.command.commandType);
      requireProject(request.params.projectId);
      const conversation = requireConversation(request.params);
      let result: ConversationLifecycleResult;
      if (conversation.transportKind === 'codex_native') {
        const executed = await application.executeExternal({
          parsed,
          destinationId: 'conversation-provider-lifecycle',
          resourceId: conversation.id,
          beforeWrite: async () => {
            requireProject(request.params.projectId);
            const current = requireConversation(request.params);
            if (action === 'restore') assertTaskCanRestore(current);
          },
          invoke: async () => {
            const current = requireConversation(request.params);
            if (action === 'archive') await options.archiveNativeConversation(current);
            else await options.restoreNativeConversation(current);
            return lifecycleResult(requireConversation(request.params));
          },
            isExplicitRejection: isConversationLifecycleExplicitRejection,
          mutateAcceptedBusinessState: (accepted) => appendLifecycleAudit(action, request.params.projectId, accepted.conversationId),
        });
        result = executed.result;
      } else {
        const executed = application.executeCore({
          parsed,
          destinationId: 'conversation-lifecycle-application',
          resourceId: conversation.id,
          mutateBusinessState: () => {
            requireProject(request.params.projectId);
            const current = requireConversation(request.params);
            if (action === 'restore') assertTaskCanRestore(current);
            if (action === 'archive') options.conversations.archive(current.id);
            else options.conversations.restore(current.id);
            appendLifecycleAudit(action, request.params.projectId, current.id);
            return lifecycleResult(requireConversation(request.params));
          },
        });
        result = executed.result;
      }
      const projected = options.conversations.getById(result.conversationId);
      if (!projected) throw notFound('ZEUS_CONVERSATION_NOT_FOUND', 'Conversation not found');
      return options.toConversationHistoryItem(projected);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  }

    function isConversationLifecycleExplicitRejection(error: unknown): boolean {
        return Boolean(error) && typeof error === 'object' && (error as {
            code?: unknown
        }).code === 'ZEUS_NATIVE_CONVERSATION_IN_PROGRESS';
    }

  function parseCommand<TInput extends object>(request: FastifyRequest<{ Params: ConversationParams; Body: ConversationMutationRequest<TInput> }>, commandType: (typeof conversationCommandTypes)[keyof typeof conversationCommandTypes]) {
    return application.parse<TInput>({ value: request.body, commandType, conversationId: request.params.conversationId });
  }

  function requireProject(projectId: string) {
    const project = options.projects.getById(projectId);
    if (!project) throw notFound('ZEUS_PROJECT_NOT_FOUND', 'Project not found');
    return project;
  }

  function requireConversation(params: ConversationParams): ZeusConversationRecord {
    const conversation = options.conversations.getRecordById(params.conversationId);
    if (!conversation || conversation.projectId !== params.projectId) throw notFound('ZEUS_CONVERSATION_NOT_FOUND', 'Conversation not found');
    return conversation;
  }

  function requireNativeConversation(params: ConversationParams, useRecord: boolean): ZeusConversationRecord {
    const conversation = useRecord ? options.conversations.getRecordById(params.conversationId) : options.conversations.getById(params.conversationId);
    if (!conversation || conversation.projectId !== params.projectId || conversation.transportKind !== 'codex_native') {
      throw notFound('ZEUS_NATIVE_CONVERSATION_NOT_FOUND', 'Native conversation not found');
    }
    return conversation;
  }

  function assertTaskCanRestore(conversation: ZeusConversationRecord): void {
    if (!conversation.taskId) return;
    const task = options.tasks.getById(conversation.taskId);
    if (task && options.isTaskTerminal(task)) {
      throw routeError('ZEUS_TASK_REOPEN_REQUIRED', 'This task is completed or cancelled. Reopen the task and restore this conversation in the same action.', 409);
    }
  }

  function goalResponse(conversation: ZeusConversationRecord, goal: ZeusConversationGoalRecord) {
    return { goal, timeline: options.goals.listEvents(conversation.id), capability: options.goalCapability(conversation) };
  }

  function appendLifecycleAudit(action: 'archive' | 'restore', projectId: string, conversationId: string): void {
    options.appendAuditLog({
      actorType: 'local_api',
      action: action === 'archive' ? 'conversation.archived' : 'conversation.restored',
      resourceType: 'conversation',
      resourceId: conversationId,
      payload: { projectId, conversationId },
    });
  }
}

interface ConversationParams {
  projectId: string;
  conversationId: string;
}

function parseNextTurnSettings(input: NextTurnSettingsInput): ConversationNextTurnSettings {
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const effort = input.effort === undefined ? undefined : typeof input.effort === 'string' ? input.effort.trim() : null;
  const hasServiceTier = Object.prototype.hasOwnProperty.call(input, 'serviceTier');
  const serviceTier = input.serviceTier;
  if (!model || effort === null || effort === '' || (hasServiceTier && serviceTier !== null && (typeof serviceTier !== 'string' || !serviceTier.trim()))) {
    throw routeError('ZEUS_INVALID_CONVERSATION_SETTINGS', 'Next turn model, reasoning effort, or service tier is invalid.', 400);
  }
  return {
    model,
    ...(effort ? { effort } : {}),
    ...(hasServiceTier ? { serviceTier: serviceTier === null ? null : (serviceTier as string).trim() } : {}),
    permissionMode: parsePermissionMode(input.permissionMode),
    collaborationMode: parseCollaborationMode(input.collaborationMode),
  };
}

function parsePermissionMode(value: unknown): ConversationPermissionMode {
  if (value === 'read-only' || value === 'auto' || value === 'full-access') return value;
  throw routeError('ZEUS_INVALID_PERMISSION_MODE', 'permissionMode must be read-only, auto, or full-access.', 400);
}

function parseCollaborationMode(value: unknown): ConversationCollaborationMode {
  if (value === 'default' || value === 'plan') return value;
  throw routeError('ZEUS_INVALID_COLLABORATION_MODE', 'collaborationMode must be default or plan.', 400);
}

function parseGoalObjective(value: unknown): string {
  if (typeof value !== 'string') throw routeError('ZEUS_CODEX_GOAL_OBJECTIVE_INVALID', '目标必须是文本。', 400);
  const objective = value.trim();
  if (!objective || [...objective].length > 4_000) throw routeError('ZEUS_CODEX_GOAL_OBJECTIVE_INVALID', '目标必须为 1 到 4000 个字符。', 400);
  return objective;
}

function lifecycleResult(conversation: ZeusConversationRecord): ConversationLifecycleResult {
  return { conversationId: conversation.id, archived: conversation.archived, updatedAt: conversation.updatedAt };
}

function assertExpectedRevision(parsed: ParsedConversationMutation<object>, expected: number | null): void {
  if (parsed.command.expectedRevision !== expected) {
    throw new ConversationCommandApplicationError('ZEUS_CONVERSATION_COMMAND_INVALID', `Command expectedRevision must be ${expected === null ? 'null' : expected}.`, 409);
  }
}

function assertExactInputKeys(value: object, expected: readonly string[], commandType: string): void {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (actual.length === normalizedExpected.length && actual.every((key, index) => key === normalizedExpected[index])) return;
  throw routeError('ZEUS_CONVERSATION_COMMAND_INVALID', `${commandType} input must contain exactly: ${normalizedExpected.join(', ')}.`, 400);
}

function assertOnlyInputKeys(value: object, allowed: readonly string[], commandType: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw routeError('ZEUS_CONVERSATION_COMMAND_INVALID', `${commandType} input contains unsupported fields: ${unexpected.sort().join(', ')}.`, 400);
}

function notFound(code: string, message: string): Error & { code: string; statusCode: number } {
  return routeError(code, message, 404);
}

function routeError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}
