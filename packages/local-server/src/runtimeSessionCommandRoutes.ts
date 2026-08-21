import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AiCliAdapterDescriptor, AiRuntimeLogEntry, AiRuntimeSession, AiRuntimeSessionManager } from '@zeus/ai-runtime';
import {
  runtimeSessionMayOwnProcess,
  type AppendAuditLogInput,
  type CreateTaskEventInput,
  type ProjectRepository,
  type RuntimeSessionRepository,
  type TaskManagementStatus,
  type TaskRepository,
  type ZeusRuntimeSessionRecord,
} from '@zeus/storage';
import {
  RuntimeBoundedEphemeralReplayService,
  RuntimeEphemeralCapabilityService,
  RuntimeSessionCommandApplication,
  runtimeSessionCommandHttpError,
  runtimeSessionCommandTypes,
  type RuntimeSessionMutationRequest,
} from './runtimeSessionCommandApplication.js';

interface CreateRuntimeSessionInput {
  projectId: string;
  taskId?: string;
  command: string;
  args?: string[];
  cwd?: string;
  confirmationId?: string;
}

interface RuntimeConfirmationSessionInput {
  projectId: string;
  taskId?: string;
  command: string;
  args?: string[];
  cwd?: string;
}

interface CreateRuntimeConfirmationInput {
  action?: 'start_generic_session';
  reason?: string;
  session?: RuntimeConfirmationSessionInput;
}

interface RejectRuntimeConfirmationInput {
  reason?: string;
}

interface RuntimeInputValue {
  input?: string;
}

interface RuntimeResizeValue {
  cols?: number;
  rows?: number;
}

interface UpdateRuntimeFavoriteInput {
  favorite?: boolean;
}

interface CreateTaskFromRuntimeSessionInput {
  title?: string;
  instruction?: string;
}

type EmptyInput = Record<string, never>;

export interface RuntimeConfirmationSecurityContext {
  operationKind: 'shell_command';
  requiresConfirmation: true;
  riskLevel: 'high';
  projectId: string;
  taskId: string | null;
  cwd: string;
  commandPreview: string;
  redacted: boolean;
}

export interface RuntimeOperationConfirmation {
  id: string;
  action: 'start_generic_session';
  status: 'pending' | 'confirmed' | 'consumed' | 'rejected';
  riskLevel: 'high';
  reason: string;
  securityContext: RuntimeConfirmationSecurityContext;
  session: Required<Pick<RuntimeConfirmationSessionInput, 'projectId' | 'command' | 'args' | 'cwd'>> & Pick<RuntimeConfirmationSessionInput, 'taskId'>;
  createdAt: string;
  confirmedAt: string | null;
  consumedAt: string | null;
  rejectedAt?: string | null;
  rejectedReason?: string | null;
}

interface RuntimeStartPreparation {
  projectRoot: string;
  adapter: AiCliAdapterDescriptor;
  confirmation?: RuntimeOperationConfirmation;
}

type RuntimeStopPreparation = { kind: 'live'; session: AiRuntimeSession } | { kind: 'persisted_orphan' };

class RuntimeConfirmationCapabilityRegistry {
  private readonly entries = new Map<string, { confirmation: RuntimeOperationConfirmation; expiresAtMs: number }>();

  constructor(
    private readonly nowMs: () => number,
    private readonly ttlMs = 10 * 60_000,
    private readonly maximumEntries = 256,
  ) {}

  get(id: string): RuntimeOperationConfirmation | undefined {
    this.prune();
    return this.entries.get(id)?.confirmation;
  }

  set(confirmation: RuntimeOperationConfirmation): void {
    this.prune();
    this.entries.set(confirmation.id, { confirmation, expiresAtMs: this.nowMs() + this.ttlMs });
    while (this.entries.size > this.maximumEntries) this.entries.delete(this.entries.keys().next().value as string);
  }

  private prune(): void {
    const nowMs = this.nowMs();
    for (const [id, entry] of this.entries) if (entry.expiresAtMs <= nowMs) this.entries.delete(id);
  }
}

export const runtimeSessionRoutePolicy = {
  durableCommands: [
    'POST /api/runtime/sessions',
    'POST /api/runtime/sessions/:sessionId/interrupt',
    'POST /api/runtime/sessions/:sessionId/stop',
    'POST /api/runtime/sessions/:sessionId/summary',
    'PUT /api/runtime/sessions/:sessionId/favorite',
    'POST /api/runtime/sessions/:sessionId/archive',
    'POST /api/runtime/sessions/:sessionId/restore',
    'POST /api/runtime/sessions/:sessionId/tasks',
    'DELETE /api/runtime/sessions/:sessionId',
  ],
  ephemeralCapabilities: [
    'POST /api/runtime/confirmations',
    'POST /api/runtime/confirmations/:confirmationId/reject',
    'POST /api/runtime/confirmations/:confirmationId/confirm',
    'POST /api/runtime/sessions/:sessionId/capabilities/ephemeral',
    'POST /api/runtime/sessions/:sessionId/input',
    'POST /api/runtime/sessions/:sessionId/resize',
  ],
} as const;

export function registerRuntimeSessionCommandRoutes(options: {
  server: FastifyInstance;
  application: RuntimeSessionCommandApplication;
  ephemeralCapabilities: RuntimeEphemeralCapabilityService;
  aiRuntimeManager: AiRuntimeSessionManager;
  runtimeSessions: RuntimeSessionRepository;
  projects: Pick<ProjectRepository, 'getById'>;
  tasks: Pick<TaskRepository, 'getById' | 'create'>;
  resolveRegisteredRuntimeAdapter(command: string): AiCliAdapterDescriptor | null;
  resolveExistingRuntimeSessionAdapter(command: string): AiCliAdapterDescriptor | null;
  readProjectAllowsShell(projectId: string): boolean;
  buildRuntimeProcessEnv(): NodeJS.ProcessEnv;
  resolveTaskDefaultManagementStatus(projectId: string): TaskManagementStatus;
  stopPersistedOrphanRuntimeSession(sessionId: string): Promise<AiRuntimeSession | null>;
  toAiRuntimeSession(record: ZeusRuntimeSessionRecord): AiRuntimeSession;
  toAiRuntimeLogEntry(record: ReturnType<RuntimeSessionRepository['listRecentLogs']>[number]): AiRuntimeLogEntry;
  parseRuntimeArgs(argsJson: string): string[];
  runtimeSessionIsConfirmedTerminal(session: { status: string; endedAt?: string | null }): boolean;
  redactSensitiveText(value: string): { text: string; redacted: boolean };
  appendAuditLog(input: Omit<AppendAuditLogInput, 'createdAt'> & { createdAt?: string }): void;
  recordTaskEvent(input: CreateTaskEventInput): unknown;
  publishRealtimeEvent(type: string, payload: Record<string, unknown>): unknown;
  publishRuntimeSessionEvent(type: 'runtime.session.created' | 'runtime.session.stop_requested' | 'runtime.session.stopped', session: AiRuntimeSession, extra?: Record<string, unknown>): void;
  save(): Promise<void>;
  now(): Date;
}): void {
  const confirmations = new RuntimeConfirmationCapabilityRegistry(() => options.now().getTime());
  const confirmationReplay = new RuntimeBoundedEphemeralReplayService({ nowMs: () => options.now().getTime() });
  const { server, application } = options;

  server.post('/api/runtime/confirmations', async (request: FastifyRequest<{ Body: RuntimeSessionMutationRequest<CreateRuntimeConfirmationInput> }>, reply) => {
    try {
      const parsed = application.parse<CreateRuntimeConfirmationInput>({
        value: request.body,
        commandType: runtimeSessionCommandTypes.confirmationCreate,
        scopeKind: 'approval',
        expectedScopeId: ({ operationIdentity }) => operationIdentity,
      });
      assertAllowedKeys(parsed.input, ['action', 'reason', 'session'], parsed.command.commandType);
      const replay = confirmationReplay.replay<CreateRuntimeConfirmationInput, RuntimeOperationConfirmation>(parsed);
      if (replay) return reply.code(200).send(replay.result);
      const prepared = await prepareRuntimeConfirmation(options, parsed.input);
      const mutation = confirmationReplay.execute(parsed, () => {
        const createdAt = options.now().toISOString();
        const confirmation: RuntimeOperationConfirmation = {
          id: parsed.operationIdentity,
          action: 'start_generic_session',
          status: 'pending',
          riskLevel: 'high',
          reason: options.redactSensitiveText(prepared.reason).text,
          securityContext: buildRuntimeConfirmationSecurityContext(prepared.session, options.redactSensitiveText),
          session: prepared.session,
          createdAt,
          confirmedAt: null,
          consumedAt: null,
        };
        confirmations.set(confirmation);
        return toRuntimeOperationConfirmationResponse(confirmation, options.redactSensitiveText);
      });
      if (!mutation.replayed) {
        appendConfirmationCreatedAudit(options, mutation.result);
        options.publishRealtimeEvent('runtime.confirmation.created', confirmationEvent(mutation.result));
      }
      return reply.code(mutation.replayed ? 200 : 201).send(mutation.result);
    } catch (error) {
      return sendRuntimeCommandError(reply, error);
    }
  });

  server.post('/api/runtime/confirmations/:confirmationId/reject', async (request: FastifyRequest<{ Params: { confirmationId: string }; Body: RuntimeSessionMutationRequest<RejectRuntimeConfirmationInput> }>, reply) => {
    try {
      const confirmationId = requiredIdentity(request.params.confirmationId, 'confirmationId');
      const parsed = application.parse<RejectRuntimeConfirmationInput>({
        value: request.body,
        commandType: runtimeSessionCommandTypes.confirmationReject,
        scopeKind: 'approval',
        expectedScopeId: () => confirmationId,
      });
      assertAllowedKeys(parsed.input, ['reason'], parsed.command.commandType);
      const mutation = confirmationReplay.execute(parsed, () => {
        const existing = requirePendingConfirmation(confirmations, confirmationId);
        const rejectedAt = options.now().toISOString();
        const rawReason = optionalTrimmedString(parsed.input.reason, 'reason');
        const rejected: RuntimeOperationConfirmation = {
          ...existing,
          status: 'rejected',
          rejectedAt,
          rejectedReason: rawReason ? options.redactSensitiveText(rawReason).text : null,
        };
        confirmations.set(rejected);
        return toRuntimeOperationConfirmationResponse(rejected, options.redactSensitiveText);
      });
      if (!mutation.replayed) {
        options.appendAuditLog({
          actorType: 'local_api',
          action: 'security.confirmation.rejected',
          resourceType: 'runtime_confirmation',
          resourceId: mutation.result.id,
          payload: {
            action: mutation.result.action,
            securityContext: mutation.result.securityContext,
            rejectedAt: mutation.result.rejectedAt,
            rejectedReason: mutation.result.rejectedReason,
          },
          createdAt: mutation.result.rejectedAt ?? undefined,
        });
        options.publishRealtimeEvent('security.confirmation.rejected', confirmationEvent(mutation.result));
      }
      return mutation.result;
    } catch (error) {
      return sendRuntimeCommandError(reply, error);
    }
  });

  server.post('/api/runtime/confirmations/:confirmationId/confirm', async (request: FastifyRequest<{ Params: { confirmationId: string }; Body: RuntimeSessionMutationRequest<EmptyInput> }>, reply) => {
    try {
      const confirmationId = requiredIdentity(request.params.confirmationId, 'confirmationId');
      const parsed = application.parse<EmptyInput>({
        value: request.body,
        commandType: runtimeSessionCommandTypes.confirmationConfirm,
        scopeKind: 'approval',
        expectedScopeId: () => confirmationId,
      });
      assertAllowedKeys(parsed.input, [], parsed.command.commandType);
      const mutation = confirmationReplay.execute(parsed, () => {
        const existing = requirePendingConfirmation(confirmations, confirmationId);
        const confirmedAt = options.now().toISOString();
        const confirmed: RuntimeOperationConfirmation = { ...existing, status: 'confirmed', confirmedAt };
        confirmations.set(confirmed);
        return toRuntimeOperationConfirmationResponse(confirmed, options.redactSensitiveText);
      });
      if (!mutation.replayed) {
        options.appendAuditLog({
          actorType: 'local_api',
          action: 'runtime.confirmation.confirmed',
          resourceType: 'runtime_confirmation',
          resourceId: mutation.result.id,
          payload: { action: mutation.result.action, securityContext: mutation.result.securityContext, confirmedAt: mutation.result.confirmedAt },
          createdAt: mutation.result.confirmedAt ?? undefined,
        });
        options.appendAuditLog({
          actorType: 'local_api',
          action: 'security.confirmation.approved',
          resourceType: 'runtime_confirmation',
          resourceId: mutation.result.id,
          payload: { action: mutation.result.action, securityContext: mutation.result.securityContext, confirmedAt: mutation.result.confirmedAt },
          createdAt: mutation.result.confirmedAt ?? undefined,
        });
        options.publishRealtimeEvent('security.confirmation.approved', confirmationEvent(mutation.result));
      }
      return mutation.result;
    } catch (error) {
      return sendRuntimeCommandError(reply, error);
    }
  });

  server.post('/api/runtime/sessions', async (request: FastifyRequest<{ Body: RuntimeSessionMutationRequest<CreateRuntimeSessionInput> }>, reply) => {
    try {
      const parsed = application.parse<CreateRuntimeSessionInput>({
        value: request.body,
        commandType: runtimeSessionCommandTypes.sessionStart,
        scopeKind: 'runtime_segment',
        expectedScopeId: ({ operationIdentity }) => operationIdentity,
      });
      validateRuntimeStartShape(parsed.input, parsed.command.commandType);
      let prepared: RuntimeStartPreparation | undefined;
      const mutation = await application.executeExternal({
        parsed,
        destinationId: 'runtime-process-manager',
        resourceId: parsed.operationIdentity,
        externalOperationId: `runtime-session-start:${parsed.operationIdentity}`,
        beforeWrite: async () => {
          prepared = await prepareRuntimeStart(options, confirmations, parsed.input);
          if (prepared.confirmation) consumeRuntimeConfirmation(options, confirmations, prepared.confirmation);
        },
        invoke: async () => {
          if (!prepared) throw new RuntimeSessionRouteError('ZEUS_RUNTIME_SESSION_REJECTED', 'Runtime session preflight did not complete.', 409);
          return options.aiRuntimeManager.startSession({
            id: parsed.operationIdentity,
            projectId: parsed.input.projectId,
            taskId: parsed.input.taskId,
            command: parsed.input.command,
            args: parsed.input.args ?? [],
            cwd: parsed.input.cwd ?? prepared.projectRoot,
            env: options.buildRuntimeProcessEnv(),
          });
        },
        mutateAcceptedBusinessState: (session) => {
          options.appendAuditLog({
            actorType: 'local_api',
            action: 'runtime.session.created',
            resourceType: 'runtime_session',
            resourceId: session.id,
            payload: { sessionId: session.id, projectId: session.projectId, taskId: session.taskId, command: session.command, cwd: session.cwd, argCount: session.args.length },
          });
          return session;
        },
      });
      if (!mutation.replayed) options.publishRuntimeSessionEvent('runtime.session.created', mutation.result);
      return reply.code(mutation.replayed ? 200 : 201).send(mutation.result);
    } catch (error) {
      return sendRuntimeCommandError(reply, error, 'ZEUS_RUNTIME_SESSION_REJECTED', 'Runtime session rejected');
    }
  });

  server.post('/api/runtime/sessions/:sessionId/capabilities/ephemeral', async (request: FastifyRequest<{ Params: { sessionId: string }; Body: { clientId?: string } }>, reply) => {
    try {
      const sessionId = requiredIdentity(request.params.sessionId, 'sessionId');
      requireWritableLiveSession(options, sessionId, 'ZEUS_RUNTIME_EPHEMERAL_LEASE_REQUIRED');
      return options.ephemeralCapabilities.issue(sessionId, request.body);
    } catch (error) {
      return sendRuntimeCommandError(reply, error, 'ZEUS_RUNTIME_EPHEMERAL_LEASE_REQUIRED', 'Runtime ephemeral lease rejected');
    }
  });

  server.post('/api/runtime/sessions/:sessionId/input', async (request: FastifyRequest<{ Params: { sessionId: string }; Body: unknown }>, reply) => {
    try {
      const sessionId = requiredIdentity(request.params.sessionId, 'sessionId');
      const executed = options.ephemeralCapabilities.execute<RuntimeInputValue, AiRuntimeSession>({
        sessionId,
        kind: 'input',
        value: request.body,
        invoke: (value) => {
          assertAllowedKeys(value, ['input'], 'runtime.ephemeral.input');
          if (typeof value.input !== 'string' || value.input.length === 0) throw new RuntimeSessionRouteError('ZEUS_INVALID_RUNTIME_INPUT', 'Runtime input is required', 400);
          requireWritableLiveSession(options, sessionId, 'ZEUS_RUNTIME_INPUT_REJECTED');
          return options.aiRuntimeManager.inputSession(sessionId, value.input);
        },
      });
      return executed.result;
    } catch (error) {
      return sendRuntimeCommandError(reply, error, 'ZEUS_RUNTIME_INPUT_REJECTED', 'Runtime input rejected');
    }
  });

  server.post('/api/runtime/sessions/:sessionId/interrupt', async (request: FastifyRequest<{ Params: { sessionId: string }; Body: RuntimeSessionMutationRequest<EmptyInput> }>, reply) => {
    try {
      const sessionId = requiredIdentity(request.params.sessionId, 'sessionId');
      const parsed = application.parse<EmptyInput>({
        value: request.body,
        commandType: runtimeSessionCommandTypes.sessionInterrupt,
        scopeKind: 'runtime_segment',
        expectedScopeId: () => sessionId,
      });
      assertAllowedKeys(parsed.input, [], parsed.command.commandType);
      const mutation = await application.executeExternal({
        parsed,
        destinationId: 'runtime-process-manager',
        resourceId: sessionId,
        externalOperationId: `runtime-session-interrupt:${sessionId}:${parsed.operationIdentity}`,
        beforeWrite: async () => {
          requireWritableLiveSession(options, sessionId, 'ZEUS_RUNTIME_INTERRUPT_REJECTED');
        },
        invoke: async () => options.aiRuntimeManager.interruptSession(sessionId),
        mutateAcceptedBusinessState: (session) => {
          options.appendAuditLog({
            actorType: 'local_api',
            action: 'runtime.session.interrupt',
            resourceType: 'runtime_session',
            resourceId: session.id,
            payload: { sessionId: session.id, projectId: session.projectId, taskId: session.taskId, signal: 'SIGINT' },
          });
          return session;
        },
      });
      return mutation.result;
    } catch (error) {
      return sendRuntimeCommandError(reply, error, 'ZEUS_RUNTIME_INTERRUPT_REJECTED', 'Runtime interrupt rejected');
    }
  });

  server.post('/api/runtime/sessions/:sessionId/resize', async (request: FastifyRequest<{ Params: { sessionId: string }; Body: unknown }>, reply) => {
    try {
      const sessionId = requiredIdentity(request.params.sessionId, 'sessionId');
      const executed = options.ephemeralCapabilities.execute<RuntimeResizeValue, AiRuntimeSession>({
        sessionId,
        kind: 'resize',
        value: request.body,
        invoke: (value) => {
          assertAllowedKeys(value, ['cols', 'rows'], 'runtime.ephemeral.resize');
          const cols = Number(value.cols);
          const rows = Number(value.rows);
          requireWritableLiveSession(options, sessionId, 'ZEUS_RUNTIME_RESIZE_REJECTED');
          return options.aiRuntimeManager.resizeSession(sessionId, cols, rows);
        },
      });
      return executed.result;
    } catch (error) {
      return sendRuntimeCommandError(reply, error, 'ZEUS_RUNTIME_RESIZE_REJECTED', 'Runtime resize rejected');
    }
  });

  server.post('/api/runtime/sessions/:sessionId/stop', async (request: FastifyRequest<{ Params: { sessionId: string }; Body: RuntimeSessionMutationRequest<EmptyInput> }>, reply) => {
    try {
      const sessionId = requiredIdentity(request.params.sessionId, 'sessionId');
      const parsed = application.parse<EmptyInput>({
        value: request.body,
        commandType: runtimeSessionCommandTypes.sessionStop,
        scopeKind: 'runtime_segment',
        expectedScopeId: () => sessionId,
      });
      assertAllowedKeys(parsed.input, [], parsed.command.commandType);
      let preparation: RuntimeStopPreparation | undefined;
      let acceptedSource: RuntimeStopPreparation['kind'] | undefined;
      const mutation = await application.executeExternal<EmptyInput, AiRuntimeSession>({
        parsed,
        destinationId: 'runtime-process-manager',
        resourceId: sessionId,
        externalOperationId: `runtime-session-stop:${sessionId}:${parsed.operationIdentity}`,
        beforeWrite: async () => {
          const live = options.aiRuntimeManager.getSession(sessionId);
          if (live) {
            preparation = { kind: 'live', session: live };
            return;
          }
          const stored = options.runtimeSessions.getById(sessionId);
          if (!stored) throw new RuntimeSessionRouteError('ZEUS_RUNTIME_SESSION_NOT_FOUND', 'AI Runtime session not found', 404);
          if (stored.status !== 'orphan_detected') throw new RuntimeSessionRouteError('ZEUS_RUNTIME_SESSION_STOP_FAILED', 'Runtime session has no verified writable process.', 409);
          preparation = { kind: 'persisted_orphan' };
        },
        invoke: async () => {
          if (!preparation) throw new RuntimeSessionRouteError('ZEUS_RUNTIME_SESSION_STOP_FAILED', 'Runtime stop preflight did not complete.', 409);
          if (preparation.kind === 'persisted_orphan') {
            const stopped = await options.stopPersistedOrphanRuntimeSession(sessionId);
            if (!stopped) throw new RuntimeSessionRouteError('ZEUS_RUNTIME_ORPHAN_STOP_FAILED', 'Runtime 孤儿进程树终止失败，仍保留待处理状态。', 409);
            acceptedSource = 'persisted_orphan';
            return stopped;
          }
          const current = preparation.session;
          const stopped = !options.runtimeSessionIsConfirmedTerminal(current) && !runtimeSessionMayOwnProcess(current.status) ? options.aiRuntimeManager.killSession(sessionId, 'SIGKILL') : options.aiRuntimeManager.stopSession(sessionId);
          acceptedSource = 'live';
          return stopped;
        },
        mutateAcceptedBusinessState: (session) => {
          if (acceptedSource === 'live') {
            options.appendAuditLog({
              actorType: 'local_api',
              action: 'runtime.session.stop_requested',
              resourceType: 'runtime_session',
              resourceId: session.id,
              payload: { sessionId: session.id, projectId: session.projectId, taskId: session.taskId, status: session.status },
            });
          }
          return session;
        },
      });
      if (!mutation.replayed && acceptedSource === 'live') options.publishRuntimeSessionEvent('runtime.session.stop_requested', mutation.result);
      return mutation.result;
    } catch (error) {
      return sendRuntimeCommandError(reply, error, 'ZEUS_RUNTIME_SESSION_STOP_FAILED', 'Runtime session stop failed');
    }
  });

  registerRuntimeCoreSessionRoutes(options);
}

function registerRuntimeCoreSessionRoutes(options: Parameters<typeof registerRuntimeSessionCommandRoutes>[0]): void {
  const { server, application } = options;

  server.post('/api/runtime/sessions/:sessionId/summary', async (request: FastifyRequest<{ Params: { sessionId: string }; Body: RuntimeSessionMutationRequest<EmptyInput> }>, reply) => {
    try {
      const { sessionId, parsed } = parseEmptySessionCommand(options, request.params.sessionId, request.body, runtimeSessionCommandTypes.sessionSummaryGenerate);
      const replay = application.replayAcceptedCore<EmptyInput, AiRuntimeSession>({ parsed, destinationId: 'runtime-session-application', resourceId: sessionId });
      if (replay) return replay.result;
      const mutation = application.executeCore({
        parsed,
        destinationId: 'runtime-session-application',
        resourceId: sessionId,
        mutateBusinessState: () => {
          const session = options.runtimeSessions.generateSummary(sessionId);
          options.appendAuditLog({
            actorType: 'local_api',
            action: 'runtime.session.summary.generated',
            resourceType: 'runtime_session',
            resourceId: session.id,
            payload: { sessionId: session.id, projectId: session.projectId, taskId: session.taskId, hasSummary: Boolean(session.summary) },
          });
          return options.toAiRuntimeSession(session);
        },
      });
      return mutation.result;
    } catch (error) {
      return sendRuntimeCommandError(reply, error, 'ZEUS_RUNTIME_SESSION_NOT_FOUND', 'AI Runtime session not found');
    }
  });

  server.put('/api/runtime/sessions/:sessionId/favorite', async (request: FastifyRequest<{ Params: { sessionId: string }; Body: RuntimeSessionMutationRequest<UpdateRuntimeFavoriteInput> }>, reply) => {
    try {
      const sessionId = requiredIdentity(request.params.sessionId, 'sessionId');
      const parsed = application.parse<UpdateRuntimeFavoriteInput>({
        value: request.body,
        commandType: runtimeSessionCommandTypes.sessionFavoriteSet,
        scopeKind: 'runtime_segment',
        expectedScopeId: () => sessionId,
      });
      assertAllowedKeys(parsed.input, ['favorite'], parsed.command.commandType);
      if (typeof parsed.input.favorite !== 'boolean') throw new RuntimeSessionRouteError('ZEUS_INVALID_RUNTIME_FAVORITE', 'favorite must be a boolean.', 400);
      const replay = application.replayAcceptedCore<UpdateRuntimeFavoriteInput, AiRuntimeSession>({ parsed, destinationId: 'runtime-session-application', resourceId: sessionId });
      if (replay) return replay.result;
      const mutation = application.executeCore({
        parsed,
        destinationId: 'runtime-session-application',
        resourceId: sessionId,
        mutateBusinessState: () => {
          const session = options.runtimeSessions.setFavorite(sessionId, parsed.input.favorite!);
          options.appendAuditLog({
            actorType: 'local_api',
            action: 'runtime.session.favorite.updated',
            resourceType: 'runtime_session',
            resourceId: session.id,
            payload: { sessionId: session.id, projectId: session.projectId, taskId: session.taskId, favorite: parsed.input.favorite },
          });
          return options.toAiRuntimeSession(session);
        },
      });
      return mutation.result;
    } catch (error) {
      return sendRuntimeCommandError(reply, error, 'ZEUS_RUNTIME_SESSION_NOT_FOUND', 'AI Runtime session not found');
    }
  });

  server.post('/api/runtime/sessions/:sessionId/archive', async (request: FastifyRequest<{ Params: { sessionId: string }; Body: RuntimeSessionMutationRequest<EmptyInput> }>, reply) =>
    executeArchiveRestore(request.params.sessionId, request.body, reply, 'archive', runtimeSessionCommandTypes.sessionArchive),
  );

  server.post('/api/runtime/sessions/:sessionId/restore', async (request: FastifyRequest<{ Params: { sessionId: string }; Body: RuntimeSessionMutationRequest<EmptyInput> }>, reply) =>
    executeArchiveRestore(request.params.sessionId, request.body, reply, 'restore', runtimeSessionCommandTypes.sessionRestore),
  );

  async function executeArchiveRestore(
    rawSessionId: string,
    body: RuntimeSessionMutationRequest<EmptyInput>,
    reply: FastifyReply,
    action: 'archive' | 'restore',
    commandType: typeof runtimeSessionCommandTypes.sessionArchive | typeof runtimeSessionCommandTypes.sessionRestore,
  ): Promise<unknown> {
    try {
      const { sessionId, parsed } = parseEmptySessionCommand(options, rawSessionId, body, commandType);
      const replay = application.replayAcceptedCore<EmptyInput, AiRuntimeSession>({ parsed, destinationId: 'runtime-session-application', resourceId: sessionId });
      if (replay) return replay.result;
      if (action === 'archive') {
        const existing = options.runtimeSessions.getById(sessionId);
        if (!existing) throw new RuntimeSessionRouteError('ZEUS_RUNTIME_SESSION_NOT_FOUND', 'AI Runtime session not found', 404);
        if (!options.runtimeSessionIsConfirmedTerminal(existing)) {
          throw new RuntimeSessionRouteError('ZEUS_RUNTIME_SESSION_ACTIVE', '运行中或待确认的 Runtime 会话不能归档，请先停止并确认整个进程树已经退出。', 409);
        }
      }
      const mutation = application.executeCore({
        parsed,
        destinationId: 'runtime-session-application',
        resourceId: sessionId,
        mutateBusinessState: () => {
          const session = action === 'archive' ? options.runtimeSessions.archive(sessionId) : options.runtimeSessions.restore(sessionId);
          options.appendAuditLog({
            actorType: 'local_api',
            action: action === 'archive' ? 'runtime.session.archived' : 'runtime.session.restored',
            resourceType: 'runtime_session',
            resourceId: session.id,
            payload: { sessionId: session.id, projectId: session.projectId, taskId: session.taskId, archived: action === 'archive' },
          });
          return options.toAiRuntimeSession(session);
        },
      });
      return mutation.result;
    } catch (error) {
      return sendRuntimeCommandError(reply, error, 'ZEUS_RUNTIME_SESSION_NOT_FOUND', 'AI Runtime session not found');
    }
  }

  server.post('/api/runtime/sessions/:sessionId/tasks', async (request: FastifyRequest<{ Params: { sessionId: string }; Body: RuntimeSessionMutationRequest<CreateTaskFromRuntimeSessionInput> }>, reply) => {
    try {
      const sessionId = requiredIdentity(request.params.sessionId, 'sessionId');
      const parsed = application.parse<CreateTaskFromRuntimeSessionInput>({
        value: request.body,
        commandType: runtimeSessionCommandTypes.sessionTaskCreate,
        scopeKind: 'runtime_segment',
        expectedScopeId: () => sessionId,
      });
      assertAllowedKeys(parsed.input, ['instruction', 'title'], parsed.command.commandType);
      const replay = application.replayAcceptedCore<CreateTaskFromRuntimeSessionInput, ReturnType<TaskRepository['create']>>({
        parsed,
        destinationId: 'runtime-session-task-application',
        resourceId: sessionId,
      });
      if (replay) return reply.code(200).send(replay.result);
      const session = options.runtimeSessions.getById(sessionId);
      if (!session) throw new RuntimeSessionRouteError('ZEUS_RUNTIME_SESSION_NOT_FOUND', 'AI Runtime session not found', 404);
      if (!options.projects.getById(session.projectId)) throw new RuntimeSessionRouteError('ZEUS_PROJECT_NOT_FOUND', 'Runtime session project not found', 404);
      const logs = options.runtimeSessions.listRecentLogs(session.id, 10).map(options.toAiRuntimeLogEntry);
      const logCount = options.runtimeSessions.searchLogs(session.id, { limit: 1 }).total;
      const instruction = optionalTrimmedString(parsed.input.instruction, 'instruction') || '基于真实 Runtime 会话继续分析后续处理事项。';
      const title = optionalTrimmedString(parsed.input.title, 'title') || `继续会话：${session.command}`;
      const mutation = application.executeCore({
        parsed,
        destinationId: 'runtime-session-task-application',
        resourceId: sessionId,
        mutateBusinessState: () => {
          const existing = options.tasks.getById(parsed.operationIdentity);
          if (existing) return existing;
          const task = options.tasks.create({
            id: parsed.operationIdentity,
            projectId: session.projectId,
            managementStatus: options.resolveTaskDefaultManagementStatus(session.projectId),
            title,
            taskType: 'requirement',
            description: [
              instruction,
              `Runtime 会话：${session.id}`,
              `命令：${[session.command, ...options.parseRuntimeArgs(session.argsJson)].join(' ')}`,
              `工作目录：${session.cwd}`,
              `日志摘要：${session.summary ?? logs.at(-1)?.text ?? '未生成摘要'}`,
            ].join('\n'),
            createdFrom: 'runtime_session',
            sourceContext: {
              runtimeSessionId: session.id,
              projectId: session.projectId,
              taskId: session.taskId,
              command: session.command,
              args: options.parseRuntimeArgs(session.argsJson),
              cwd: session.cwd,
              logs: logs.slice(-10),
            },
          });
          // 该端口还会写本地任务 JSONL；审计据此将本路由精确标为 partial，而非伪装全原子。
          options.recordTaskEvent({
            taskId: task.id,
            eventType: 'task.created.from_runtime_session',
            title: '任务从 Runtime 会话创建',
            payload: { runtimeSessionId: session.id, logCount },
          });
          options.appendAuditLog({
            actorType: 'local_api',
            action: 'runtime.session.task.created',
            resourceType: 'runtime_session',
            resourceId: session.id,
            payload: { sessionId: session.id, projectId: session.projectId, sourceTaskId: session.taskId, createdTaskId: task.id, logCount: logs.length },
          });
          return task;
        },
      });
      return reply.code(mutation.replayed ? 200 : 201).send(mutation.result);
    } catch (error) {
      return sendRuntimeCommandError(reply, error);
    }
  });

  server.delete('/api/runtime/sessions/:sessionId', async (request: FastifyRequest<{ Params: { sessionId: string }; Body: RuntimeSessionMutationRequest<EmptyInput> }>, reply) => {
    try {
      const { sessionId, parsed } = parseEmptySessionCommand(options, request.params.sessionId, request.body, runtimeSessionCommandTypes.sessionDelete);
      const replay = application.replayAcceptedCore<EmptyInput, AiRuntimeSession>({ parsed, destinationId: 'runtime-session-application', resourceId: sessionId });
      if (replay) return replay.result;
      const existing = options.runtimeSessions.getById(sessionId);
      if (!existing) throw new RuntimeSessionRouteError('ZEUS_RUNTIME_SESSION_NOT_FOUND', 'AI Runtime session not found', 404);
      if (!options.runtimeSessionIsConfirmedTerminal(existing)) {
        throw new RuntimeSessionRouteError('ZEUS_RUNTIME_SESSION_ACTIVE', '运行中或待确认的 Runtime 会话不能删除，请先停止并确认整个进程树已经退出。', 409);
      }
      const mutation = application.executeCore({
        parsed,
        destinationId: 'runtime-session-application',
        resourceId: sessionId,
        mutateBusinessState: () => {
          const session = options.runtimeSessions.delete(sessionId);
          options.appendAuditLog({
            actorType: 'local_api',
            action: 'runtime.session.deleted',
            resourceType: 'runtime_session',
            resourceId: session.id,
            payload: { sessionId: session.id, projectId: session.projectId, taskId: session.taskId, deletedAt: session.deletedAt },
          });
          return options.toAiRuntimeSession(session);
        },
      });
      return mutation.result;
    } catch (error) {
      return sendRuntimeCommandError(reply, error);
    }
  });
}

async function prepareRuntimeConfirmation(options: Parameters<typeof registerRuntimeSessionCommandRoutes>[0], input: CreateRuntimeConfirmationInput): Promise<{ reason: string; session: RuntimeOperationConfirmation['session'] }> {
  if (input.action !== 'start_generic_session' || !input.reason?.trim() || !input.session?.projectId || !input.session.command) {
    throw new RuntimeSessionRouteError('ZEUS_INVALID_RUNTIME_CONFIRMATION', 'action, reason and session are required for runtime confirmation', 400);
  }
  assertAllowedKeys(input.session, ['args', 'command', 'cwd', 'projectId', 'taskId'], 'runtime.confirmation.session');
  if (options.resolveRegisteredRuntimeAdapter(input.session.command)?.id !== 'generic') {
    throw new RuntimeSessionRouteError('ZEUS_INVALID_RUNTIME_CONFIRMATION', 'runtime confirmation is only required for Generic shell sessions', 400);
  }
  const project = options.projects.getById(input.session.projectId);
  if (!project) throw new RuntimeSessionRouteError('ZEUS_PROJECT_NOT_FOUND', 'Project not found', 404);
  if (!options.readProjectAllowsShell(project.id)) {
    throw new RuntimeSessionRouteError('ZEUS_RUNTIME_SHELL_PERMISSION_REQUIRED', 'Project must enable allowShell before Generic shell sessions can be confirmed', 403);
  }
  const session = {
    projectId: requiredIdentity(input.session.projectId, 'session.projectId'),
    ...(input.session.taskId ? { taskId: requiredIdentity(input.session.taskId, 'session.taskId') } : {}),
    command: requiredIdentity(input.session.command, 'session.command'),
    args: optionalStringArray(input.session.args, 'session.args'),
    cwd: input.session.cwd ?? project.localPath,
  };
  await assertRuntimeSecurity(options, session, project.localPath, 'confirmation');
  return { reason: input.reason.trim(), session };
}

async function prepareRuntimeStart(options: Parameters<typeof registerRuntimeSessionCommandRoutes>[0], confirmations: RuntimeConfirmationCapabilityRegistry, input: CreateRuntimeSessionInput): Promise<RuntimeStartPreparation> {
  const adapter = options.resolveRegisteredRuntimeAdapter(input.command);
  if (!adapter) throw new RuntimeSessionRouteError('ZEUS_UNSUPPORTED_RUNTIME_COMMAND', 'Runtime sessions can only start registered AI CLI adapter commands', 400);
  if (adapter.id === 'codex') throw new RuntimeSessionRouteError('ZEUS_CODEX_NATIVE_APP_SERVER_REQUIRED', 'Codex Runtime writes require the native app-server transport.', 409);
  const project = options.projects.getById(input.projectId);
  if (!project) throw new RuntimeSessionRouteError('ZEUS_PROJECT_NOT_FOUND', 'Project not found', 404);
  if (adapter.id === 'generic' && !options.readProjectAllowsShell(project.id)) {
    throw new RuntimeSessionRouteError('ZEUS_RUNTIME_SHELL_PERMISSION_REQUIRED', 'Project must enable allowShell before Generic shell sessions can run', 403);
  }
  await assertRuntimeSecurity(options, { ...input, args: input.args ?? [], cwd: input.cwd ?? project.localPath }, project.localPath, 'session');
  if (adapter.id !== 'generic') return { projectRoot: project.localPath, adapter };
  const confirmation = input.confirmationId ? confirmations.get(input.confirmationId) : undefined;
  if (confirmation?.status === 'rejected') throw new RuntimeSessionRouteError('ZEUS_RUNTIME_CONFIRMATION_REJECTED', 'Runtime confirmation was rejected', 409);
  if (!confirmation || !canConsumeGenericRuntimeConfirmation(confirmation, input, project.localPath)) {
    throw new RuntimeSessionRouteError('ZEUS_GENERIC_RUNTIME_REQUIRES_CONFIRMATION', 'Generic shell runtime requires a confirmed high-risk confirmation before it can start a session', 400);
  }
  return { projectRoot: project.localPath, adapter, confirmation };
}

async function assertRuntimeSecurity(
  options: Parameters<typeof registerRuntimeSessionCommandRoutes>[0],
  input: { projectId: string; taskId?: string; command: string; args: string[]; cwd: string },
  projectRoot: string,
  phase: 'confirmation' | 'session',
): Promise<void> {
  if (!isPathInsideProjectRoot(input.cwd, projectRoot)) {
    options.appendAuditLog({
      actorType: 'local_api',
      action: 'security.runtime.cwd_rejected',
      resourceType: 'runtime_session',
      payload: { projectId: input.projectId, taskId: input.taskId ?? null, phase, requestedCwd: input.cwd, projectRoot },
    });
    await options.save();
    throw new RuntimeSessionRouteError(
      'ZEUS_RUNTIME_CWD_OUTSIDE_PROJECT',
      phase === 'confirmation' ? 'Runtime cwd must stay inside the configured project root before high-risk shell confirmation can be created' : 'Runtime cwd must stay inside the configured project root',
      400,
    );
  }
  if (options.resolveRegisteredRuntimeAdapter(input.command)?.id !== 'generic') return;
  const risk = detectGenericShellRisk(input.args, projectRoot);
  if (!risk) return;
  options.appendAuditLog({
    actorType: 'local_api',
    action: risk.kind === 'outside_project' ? 'security.runtime.shell_path_rejected' : risk.kind === 'sensitive_path' ? 'security.runtime.sensitive_path_rejected' : 'security.runtime.secret_file_rejected',
    resourceType: 'runtime_confirmation',
    payload: {
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      phase,
      rejectedPath: risk.path,
      ...(risk.kind === 'outside_project' ? { projectRoot } : {}),
      commandPreview: options.redactSensitiveText(risk.commandText).text,
    },
  });
  await options.save();
  throw new RuntimeSessionRouteError(
    risk.kind === 'outside_project' ? 'ZEUS_RUNTIME_SHELL_PATH_OUTSIDE_PROJECT' : risk.kind === 'sensitive_path' ? 'ZEUS_RUNTIME_SENSITIVE_PATH_REJECTED' : 'ZEUS_RUNTIME_SECRET_FILE_REJECTED',
    risk.kind === 'outside_project'
      ? 'Generic shell command arguments must not target paths outside the configured project root'
      : risk.kind === 'sensitive_path'
        ? 'Generic shell command arguments must not access sensitive local directories'
        : 'Generic shell command arguments must not access likely secret files',
    400,
  );
}

function consumeRuntimeConfirmation(options: Parameters<typeof registerRuntimeSessionCommandRoutes>[0], confirmations: RuntimeConfirmationCapabilityRegistry, confirmation: RuntimeOperationConfirmation): void {
  const consumedAt = options.now().toISOString();
  confirmations.set({ ...confirmation, status: 'consumed', consumedAt });
  options.appendAuditLog({
    actorType: 'local_api',
    action: 'runtime.confirmation.consumed',
    resourceType: 'runtime_confirmation',
    resourceId: confirmation.id,
    payload: { action: confirmation.action, securityContext: confirmation.securityContext, consumedAt },
    createdAt: consumedAt,
  });
}

function requireWritableLiveSession(options: Parameters<typeof registerRuntimeSessionCommandRoutes>[0], sessionId: string, errorCode: string): AiRuntimeSession {
  const session = options.aiRuntimeManager.getSession(sessionId);
  if (!session) throw new RuntimeSessionRouteError(errorCode, 'AI Runtime session not found', 404);
  const adapter = options.resolveExistingRuntimeSessionAdapter(session.command);
  if (!adapter) throw new RuntimeSessionRouteError(errorCode, 'Runtime session adapter identity could not be verified.', 409);
  if (adapter.id === 'codex') throw new RuntimeSessionRouteError('ZEUS_CODEX_NATIVE_APP_SERVER_REQUIRED', 'Codex Runtime writes require the native app-server transport.', 409);
  return session;
}

function parseEmptySessionCommand(
  options: Parameters<typeof registerRuntimeSessionCommandRoutes>[0],
  rawSessionId: string,
  body: unknown,
  commandType: typeof runtimeSessionCommandTypes.sessionSummaryGenerate | typeof runtimeSessionCommandTypes.sessionArchive | typeof runtimeSessionCommandTypes.sessionRestore | typeof runtimeSessionCommandTypes.sessionDelete,
) {
  const sessionId = requiredIdentity(rawSessionId, 'sessionId');
  const parsed = options.application.parse<EmptyInput>({
    value: body,
    commandType,
    scopeKind: 'runtime_segment',
    expectedScopeId: () => sessionId,
  });
  assertAllowedKeys(parsed.input, [], parsed.command.commandType);
  return { sessionId, parsed };
}

function validateRuntimeStartShape(input: CreateRuntimeSessionInput, commandType: string): void {
  assertAllowedKeys(input, ['args', 'command', 'confirmationId', 'cwd', 'projectId', 'taskId'], commandType);
  requiredIdentity(input.projectId, 'projectId');
  requiredIdentity(input.command, 'command');
  if (input.taskId !== undefined) requiredIdentity(input.taskId, 'taskId');
  if (input.confirmationId !== undefined) requiredIdentity(input.confirmationId, 'confirmationId');
  if (input.cwd !== undefined) requiredIdentity(input.cwd, 'cwd');
  optionalStringArray(input.args, 'args');
}

function requirePendingConfirmation(confirmations: RuntimeConfirmationCapabilityRegistry, confirmationId: string): RuntimeOperationConfirmation {
  const existing = confirmations.get(confirmationId);
  if (!existing) throw new RuntimeSessionRouteError('ZEUS_RUNTIME_CONFIRMATION_NOT_FOUND', 'Runtime confirmation not found', 404);
  if (existing.status !== 'pending') throw new RuntimeSessionRouteError('ZEUS_RUNTIME_CONFIRMATION_ALREADY_USED', 'Runtime confirmation is not pending', 409);
  return existing;
}

function appendConfirmationCreatedAudit(options: Parameters<typeof registerRuntimeSessionCommandRoutes>[0], confirmation: RuntimeOperationConfirmation): void {
  const payload = { action: confirmation.action, reason: confirmation.reason, securityContext: confirmation.securityContext };
  options.appendAuditLog({ actorType: 'local_api', action: 'runtime.confirmation.created', resourceType: 'runtime_confirmation', resourceId: confirmation.id, payload, createdAt: confirmation.createdAt });
  options.appendAuditLog({ actorType: 'local_api', action: 'security.confirmation.required', resourceType: 'runtime_confirmation', resourceId: confirmation.id, payload, createdAt: confirmation.createdAt });
}

function confirmationEvent(confirmation: RuntimeOperationConfirmation): Record<string, unknown> {
  return {
    confirmationId: confirmation.id,
    action: confirmation.action,
    operation: confirmation.action,
    projectId: confirmation.session.projectId,
    taskId: confirmation.session.taskId ?? null,
    riskLevel: confirmation.riskLevel,
  };
}

function buildRuntimeConfirmationSecurityContext(session: RuntimeOperationConfirmation['session'], redact: (value: string) => { text: string; redacted: boolean }): RuntimeConfirmationSecurityContext {
  const preview = redact([session.command, ...session.args].join(' '));
  return {
    operationKind: 'shell_command',
    requiresConfirmation: true,
    riskLevel: 'high',
    projectId: session.projectId,
    taskId: session.taskId ?? null,
    cwd: session.cwd,
    commandPreview: preview.text,
    redacted: preview.redacted,
  };
}

function toRuntimeOperationConfirmationResponse(confirmation: RuntimeOperationConfirmation, redact: (value: string) => { text: string }): RuntimeOperationConfirmation {
  return { ...confirmation, session: { ...confirmation.session, args: confirmation.session.args.map((arg) => redact(arg).text) } };
}

function canConsumeGenericRuntimeConfirmation(confirmation: RuntimeOperationConfirmation, body: CreateRuntimeSessionInput, defaultCwd: string): boolean {
  const requestedArgs = body.args ?? [];
  return (
    confirmation.action === 'start_generic_session' &&
    confirmation.status === 'confirmed' &&
    confirmation.session.projectId === body.projectId &&
    confirmation.session.taskId === body.taskId &&
    confirmation.session.command === body.command &&
    confirmation.session.cwd === (body.cwd ?? defaultCwd) &&
    confirmation.session.args.length === requestedArgs.length &&
    confirmation.session.args.every((value, index) => value === requestedArgs[index])
  );
}

function detectGenericShellRisk(args: string[], projectRoot: string): { kind: 'outside_project' | 'sensitive_path' | 'secret_file'; commandText: string; path: string } | null {
  const flagIndex = args.findIndex((arg) => arg === '-c' || arg === '-lc' || arg === '-cl');
  const commandText = flagIndex < 0 ? '' : (args[flagIndex + 1]?.trim() ?? '');
  if (!commandText) return null;
  const tokens = (commandText.match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? []).map((token) => token.replace(/^['"]|['"]$/gu, ''));
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const redirect = /^(?:\d*>>?|&>)$/u.test(token) ? tokens[index + 1] : token.match(/^(?:\d*>>?|&>)(.+)$/u)?.[1];
    if (redirect?.startsWith('/') && redirect !== '/' && !isPathInsideProjectRoot(redirect, projectRoot)) return { kind: 'outside_project', commandText, path: redirect };
  }
  const writeCommands = new Set(['cp', 'mv', 'rm', 'touch', 'mkdir', 'rmdir', 'tee', 'chmod', 'chown', 'ln']);
  const commandIndex = tokens.findIndex((token) => !['sudo', 'command', 'env'].includes(token));
  if (commandIndex >= 0 && writeCommands.has(tokens[commandIndex]!.split('/').pop() ?? tokens[commandIndex]!)) {
    const path = tokens.slice(commandIndex + 1).find((token) => token.startsWith('/') && token !== '/' && !isPathInsideProjectRoot(token, projectRoot));
    if (path) return { kind: 'outside_project', commandText, path };
  }
  const sensitivePrefixes = ['/etc', '/private/etc', '~/.ssh', '~/.aws', '~/.gnupg', '~/.gpg', '~/.config/gcloud', '~/library/keychains', '~/library/application support/com.apple.tcc'];
  for (const token of tokens) {
    const normalized = token.replace(/\\+/gu, '/').toLowerCase();
    if (sensitivePrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return { kind: 'sensitive_path', commandText, path: token };
    const clean = normalized.split(/[?#]/u)[0] ?? normalized;
    const basename = clean.split('/').pop() ?? clean;
    const looksLikePath = clean.includes('/') || basename.startsWith('.') || /\.[a-z0-9]+$/iu.test(basename);
    const exact = new Set(['.env', '.env.local', '.env.production', '.env.development', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'credentials.json', 'service-account.json', 'service_account.json', 'kubeconfig']);
    if (looksLikePath && (exact.has(basename) || /\.(pem|key|p12|pfx|crt|cer)$/u.test(basename) || /(^|[-_.])(secret|secrets|token|apikey|api-key|private-key)([-_.]|$)/u.test(basename))) {
      return { kind: 'secret_file', commandText, path: token };
    }
  }
  return null;
}

function isPathInsideProjectRoot(candidatePath: string, projectRoot: string): boolean {
  const normalizedCandidate = normalizeAbsolutePath(candidatePath);
  const normalizedRoot = normalizeAbsolutePath(projectRoot);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function normalizeAbsolutePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\+/gu, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new RuntimeSessionRouteError('ZEUS_RUNTIME_COMMAND_INPUT_INVALID', `${field} must be a string array.`, 400);
  return value;
}

function optionalTrimmedString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new RuntimeSessionRouteError('ZEUS_RUNTIME_COMMAND_INPUT_INVALID', `${field} must be a string.`, 400);
  return value.trim() || undefined;
}

function requiredIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 512) throw new RuntimeSessionRouteError('ZEUS_RUNTIME_COMMAND_INPUT_INVALID', `${field} is invalid.`, 400);
  return value;
}

function assertAllowedKeys(value: object, allowed: readonly string[], context: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new RuntimeSessionRouteError('ZEUS_RUNTIME_COMMAND_INPUT_INVALID', `${context} contains unsupported fields: ${extras.join(', ')}.`, 400);
}

class RuntimeSessionRouteError extends Error {
  readonly name = 'RuntimeSessionRouteError';

  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409,
  ) {
    super(message);
  }
}

function sendRuntimeCommandError(reply: FastifyReply, error: unknown, fallbackCode = 'ZEUS_RUNTIME_COMMAND_REJECTED', fallbackMessage = 'Runtime command rejected'): unknown {
  const mapped = runtimeSessionCommandHttpError(error);
  if (mapped) return reply.code(mapped.statusCode).send(mapped.payload);
  if (error instanceof RuntimeSessionRouteError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  const status = error instanceof Error && error.message.includes('not found') ? 404 : 409;
  return reply.code(status).send({ error: fallbackCode, message: error instanceof Error ? error.message : fallbackMessage });
}
