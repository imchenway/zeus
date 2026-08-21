import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  assertExpectedRevision,
  commandNeedsHighRiskConfirmation,
  commandParameterValueMatchesType,
  defaultCommandRiskFlags,
  validateCommandDefinitionInput,
  type CommandConfirmation,
  type CommandDefinition,
  type CommandDefinitionInput,
  type CommandParameterDefinition,
  type CommandRun,
  type CommandRunTrigger,
  type CommandScope,
} from '@zeus/shared';
import { projectTerminalOutput, type AiRuntimeLogEntry, type AiRuntimeSession, type AiRuntimeSessionManager } from '@zeus/ai-runtime';
import {
  CommandArtifactRepository,
  CommandDeliveryRepository,
  CommandDefinitionRepository,
  CommandRunRepository,
  type ArtifactStore,
  type AppendAuditLogInput,
  type ProjectRepository,
  type RuntimeSessionRepository,
  type ZeusDatabase,
  type ZeusRuntimeLogRecord,
  type ZeusRuntimeSessionRecord,
} from '@zeus/storage';
import {
  CommandCenterCommandApplication,
  CommandCenterCommandApplicationError,
  commandCenterCommandTypes,
  isCommandCenterCommandError,
  type CommandCenterMutationRequest,
  type ParsedCommandCenterMutation,
} from './commandCenterCommandApplication.js';

const MAX_COMMAND_RUN_LOG_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_RUN_CLIPBOARD_BYTES = 32 * 1024 * 1024;
const COMMAND_RUN_LOG_COPY_PAGE_SIZE = 2_000;

interface CommandCenterOptions {
  server: FastifyInstance;
  db: ZeusDatabase;
  commandDeliveries: CommandDeliveryRepository;
  artifactStore: ArtifactStore;
  projects: ProjectRepository;
  runtimeSessions: RuntimeSessionRepository;
  aiRuntimeManager: AiRuntimeSessionManager;
  commandScriptsDirectory: string;
  commandRunsDirectory: string;
  resolveRuntimeSessionLogFiles?: (sessionId: string) => Array<{ relativePath: string; sourcePath: string; mimeType: string }>;
  readProjectSecurity: (projectId: string) => { allowShell: boolean; allowGitWrite: boolean };
  buildRuntimeProcessEnv: () => NodeJS.ProcessEnv;
  createReleaseNotesCapability?: (input: { runId: string; projectId: string }) => { url: string; token: string };
  revokeReleaseNotesCapability?: (runId: string) => void;
  appendAuditLog: (input: Omit<AppendAuditLogInput, 'createdAt'> & { createdAt?: string }) => void;
  publishRealtimeEvent: (type: string, payload: Record<string, unknown>) => unknown;
  save: () => Promise<void>;
  now?: () => Date;
  confirmationTtlMs?: number;
  /** 正式副本验证只注册查询面；不建目录、不恢复运行、不接纳 mutation。 */
  readOnlyValidation?: boolean;
}

interface StoredCommandConfirmation extends CommandConfirmation {
  runId: string;
  normalizedParameters: Record<string, string | number | boolean>;
  sensitiveValues: string[];
}

interface CommandConfirmationBody {
  parameters?: Record<string, unknown>;
  trigger?: CommandRunTrigger;
}

interface CommandRunBody {
  runId?: string;
  confirmationId?: string;
  parameters?: Record<string, unknown>;
}

type EmptyCommandCenterInput = Record<string, never>;

export interface CommandCenterController {
  handleRuntimeSessionChange: (session: AiRuntimeSession) => void;
  handleRuntimeLog: (log: AiRuntimeLogEntry) => void;
  stopActiveRuns: (reason: string) => number;
  close: () => void;
}

/** 注册通用用户脚本命令中心；该控制器不包含任何 Git、微信或 agents-sync 专用分支。 */
export function createCommandCenter(options: CommandCenterOptions): CommandCenterController {
  const definitions = new CommandDefinitionRepository(options.db);
  const runs = new CommandRunRepository(options.db);
  const artifacts = new CommandArtifactRepository(options.db, options.artifactStore);
  const confirmations = new Map<string, StoredCommandConfirmation>();
  const timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();
  const forceKillHandles = new Map<string, ReturnType<typeof setTimeout>>();
  const artifactBuffers = new Map<string, string>();
  const now = options.now ?? (() => new Date());
  const confirmationTtlMs = options.confirmationTtlMs ?? 10 * 60 * 1000;
  const commandApplication = new CommandCenterCommandApplication({ db: options.db, deliveries: options.commandDeliveries, now });

  if (!options.readOnlyValidation) {
    mkdirSync(options.commandScriptsDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(options.commandRunsDirectory, { recursive: true, mode: 0o700 });
    recoverInterruptedRuns();
  }

  options.server.get('/api/commands/global', async () => definitions.listGlobal());

  options.server.post('/api/commands/global', async (request: FastifyRequest<{ Body: CommandCenterMutationRequest<CommandDefinitionInput> }>, reply) => runCommandRoute(reply, () => createDefinition('global', null, request.body, reply)));

  options.server.patch('/api/commands/global/:commandId', async (request: FastifyRequest<{ Params: { commandId: string }; Body: CommandCenterMutationRequest<Partial<CommandDefinitionInput>> }>, reply) =>
    runCommandRoute(reply, () => updateDefinition('global', null, request.params.commandId, request.body, reply)),
  );

  options.server.delete('/api/commands/global/:commandId', async (request: FastifyRequest<{ Params: { commandId: string }; Body: CommandCenterMutationRequest<EmptyCommandCenterInput> }>, reply) =>
    runCommandRoute(reply, () => deleteDefinition('global', null, request.params.commandId, request.body, reply)),
  );

  options.server.get('/api/projects/:projectId/commands', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    if (!requireProject(request.params.projectId, reply)) return;
    return definitions.listMerged(request.params.projectId);
  });

  options.server.post('/api/projects/:projectId/commands', async (request: FastifyRequest<{ Params: { projectId: string }; Body: CommandCenterMutationRequest<CommandDefinitionInput> }>, reply) => {
    if (!requireProject(request.params.projectId, reply)) return;
    return runCommandRoute(reply, () => createDefinition('project', request.params.projectId, request.body, reply));
  });

  options.server.patch('/api/projects/:projectId/commands/:commandId', async (request: FastifyRequest<{ Params: { projectId: string; commandId: string }; Body: CommandCenterMutationRequest<Partial<CommandDefinitionInput>> }>, reply) => {
    if (!requireProject(request.params.projectId, reply)) return;
    return runCommandRoute(reply, () => updateDefinition('project', request.params.projectId, request.params.commandId, request.body, reply));
  });

  options.server.delete('/api/projects/:projectId/commands/:commandId', async (request: FastifyRequest<{ Params: { projectId: string; commandId: string }; Body: CommandCenterMutationRequest<EmptyCommandCenterInput> }>, reply) => {
    if (!requireProject(request.params.projectId, reply)) return;
    return runCommandRoute(reply, () => deleteDefinition('project', request.params.projectId, request.params.commandId, request.body, reply));
  });

  options.server.post('/api/projects/:projectId/commands/:commandId/confirmations', async (request: FastifyRequest<{ Params: { projectId: string; commandId: string }; Body: CommandCenterMutationRequest<CommandConfirmationBody> }>, reply) =>
    runCommandRoute(reply, () => createConfirmation(request.params.projectId, request.params.commandId, request.body, reply)),
  );

  options.server.post('/api/projects/:projectId/commands/:commandId/runs', async (request: FastifyRequest<{ Params: { projectId: string; commandId: string }; Body: CommandCenterMutationRequest<CommandRunBody> }>, reply) =>
    runCommandRoute(reply, () => startRun(request.params.projectId, request.params.commandId, request.body, reply)),
  );

  options.server.get('/api/projects/:projectId/command-runs', async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: { limit?: string } }>, reply) => {
    if (!requireProject(request.params.projectId, reply)) return;
    const requestedLimit = Number(request.query.limit ?? 100);
    return runs.listByProject(request.params.projectId, Number.isFinite(requestedLimit) ? requestedLimit : 100);
  });

  options.server.get('/api/command-runs/:runId', async (request: FastifyRequest<{ Params: { runId: string }; Querystring: { afterSeq?: string; logLimit?: string; tail?: string } }>, reply) => {
    const run = runs.getById(request.params.runId);
    if (!run) return notFound(reply, 'ZEUS_COMMAND_RUN_NOT_FOUND', 'Command run not found');
    const afterSeq = parseBoundedCommandRunInteger(request.query.afterSeq, 0, 0, Number.MAX_SAFE_INTEGER);
    const logLimit = parseBoundedCommandRunInteger(request.query.logLimit, 200, 1, 2_000);
    const tail = run.status !== 'running' && afterSeq === 0 && request.query.tail === 'true';
    const logPage = run.runtimeSessionId
      ? options.runtimeSessions.searchLogs(run.runtimeSessionId, { afterSeq, limit: logLimit, tail, byteBudget: MAX_COMMAND_RUN_LOG_PAYLOAD_BYTES })
      : { items: [], total: 0, afterSeq, nextSeq: afterSeq, hasMore: false, truncated: false };
    const boundedLogs = boundCommandRunLogs(logPage.items, afterSeq, logPage.nextSeq);
    return {
      run,
      artifacts: artifacts.listByRun(run.id),
      runtimeSession: run.runtimeSessionId ? toPublicRuntimeSession(options.runtimeSessions.getById(run.runtimeSessionId)) : null,
      logs: boundedLogs.items,
      afterSeq: logPage.afterSeq,
      nextSeq: logPage.nextSeq,
      logTotal: logPage.total,
      hasMoreLogs: logPage.hasMore,
      logsTruncated: logPage.truncated || boundedLogs.truncated,
    };
  });

  options.server.get('/api/command-runs/:runId/terminal-output', async (request: FastifyRequest<{ Params: { runId: string } }>, reply) => {
    const run = runs.getById(request.params.runId);
    if (!run) return notFound(reply, 'ZEUS_COMMAND_RUN_NOT_FOUND', 'Command run not found');
    if (!run.runtimeSessionId) return { content: '', byteLength: 0 };
    const projection = projectCompleteCommandRunOutput(options.runtimeSessions, run.runtimeSessionId, MAX_COMMAND_RUN_CLIPBOARD_BYTES);
    if (projection.exceeded) {
      return reply.code(413).send({
        error: 'ZEUS_COMMAND_RUN_LOG_COPY_TOO_LARGE',
        message: 'Command run output exceeds the 32 MiB clipboard limit. Export the complete Runtime log instead.',
      });
    }
    return { content: projection.content, byteLength: projection.byteLength };
  });

  options.server.post('/api/command-runs/:runId/stop', async (request: FastifyRequest<{ Params: { runId: string }; Body: CommandCenterMutationRequest<EmptyCommandCenterInput> }>, reply) =>
    runCommandRoute(reply, () => stopRun(request.params.runId, request.body, reply)),
  );

  options.server.get('/api/command-artifacts/:artifactId/content', async (request: FastifyRequest<{ Params: { artifactId: string } }>, reply) => {
    const artifact = findArtifactById(request.params.artifactId);
    if (!artifact) return notFound(reply, 'ZEUS_COMMAND_ARTIFACT_NOT_FOUND', 'Command artifact not found');
    const run = runs.getById(artifact.runId);
    if (!run) return notFound(reply, 'ZEUS_COMMAND_RUN_NOT_FOUND', 'Command run not found');
    if (artifact.artifactRef) {
      const resolved = await options.artifactStore.readAuthorized({
        sha256: artifact.artifactRef.sha256,
        owner: { kind: 'command_artifact', id: artifact.id },
        maximumContentBytes: 1024 * 1024 * 1024,
      });
      reply.type(artifact.mimeType ?? 'application/octet-stream');
      return reply.send(Buffer.from(resolved.bytes));
    }
    const verified = verifyArtifactPath(artifact.absolutePath, commandRunDirectory(run.id));
    if (!verified) return reply.code(410).send({ error: 'ZEUS_COMMAND_ARTIFACT_UNAVAILABLE', message: 'Command artifact is no longer available' });
    reply.type(artifact.mimeType ?? 'application/octet-stream');
    return reply.send(readFileSync(verified));
  });

  async function createDefinition(scope: CommandScope, projectId: string | null, request: CommandCenterMutationRequest<CommandDefinitionInput>, reply: FastifyReply): Promise<CommandDefinition | unknown> {
    const parsed = commandApplication.parse<CommandDefinitionInput>({
      value: request,
      commandType: commandCenterCommandTypes.definitionCreate,
      scopeKind: 'command_definition',
      expectedScopeId: ({ operationIdentity }) => definitionCreateScopeId(scope, projectId, operationIdentity),
    });
    assertCreateRevision(parsed);
    const replay = replayAcceptedCoreCommand<CommandDefinition>(parsed, parsed.operationIdentity);
    if (replay) return reply.code(201).send(replay.result);
    const input = normalizeDefinitionInput(parsed.input);
    if (!input) return invalidDefinition(reply, [{ field: 'body', message: '命令定义格式无效。' }]);
    const issues = validateCommandDefinitionInput(input);
    if (scope === 'global' && projectId !== null) issues.push({ field: 'projectId', message: '全局命令不能绑定项目。' });
    const conflicts = definitions.findTokenConflicts({
      scope,
      projectId,
      tokens: [input.name, ...(input.aliases ?? [])],
      excludeCommandId: parsed.operationIdentity,
    });
    if (conflicts.length > 0) {
      return reply.code(409).send({
        error: 'ZEUS_COMMAND_TOKEN_CONFLICT',
        message: `名称或别名与 ${conflicts[0]!.commandName} 冲突。`,
        conflicts,
      });
    }
    if (issues.length > 0) return invalidDefinition(reply, issues);
    const mutation = commandApplication.executeCore({
      parsed,
      destinationId: 'command-center-definition-application',
      resourceId: parsed.operationIdentity,
      mutateBusinessState: () => {
        const created = definitions.create({ ...input, id: parsed.operationIdentity, scope, projectId });
        options.appendAuditLog({
          ...commandAuditActor(parsed),
          action: 'command.definition.created',
          resourceType: 'command_definition',
          resourceId: created.id,
          payload: definitionAuditPayload(created),
        });
        return created;
      },
    });
    if (!mutation.replayed) {
      options.publishRealtimeEvent('command.definition.created', definitionEventPayload(mutation.result));
      await options.save();
    }
    return reply.code(201).send(mutation.result);
  }

  async function updateDefinition(
    expectedScope: CommandScope,
    expectedProjectId: string | null,
    commandId: string,
    request: CommandCenterMutationRequest<Partial<CommandDefinitionInput>>,
    reply: FastifyReply,
  ): Promise<CommandDefinition | unknown> {
    const parsed = commandApplication.parse<Partial<CommandDefinitionInput>>({
      value: request,
      commandType: commandCenterCommandTypes.definitionUpdate,
      scopeKind: 'command_definition',
      expectedScopeId: () => commandId,
    });
    const replay = replayAcceptedCoreCommand<CommandDefinition>(parsed, commandId);
    if (replay) return replay.result;
    const existing = definitions.getById(commandId);
    if (!existing || existing.scope !== expectedScope || existing.projectId !== expectedProjectId) {
      return notFound(reply, 'ZEUS_COMMAND_NOT_FOUND', 'Command definition not found');
    }
    assertExpectedRevision(existing.revision, parsed.command.expectedRevision, parsed.command.scope);
    const patch = parsed.input;
    const input = normalizeDefinitionInput({
      name: patch.name ?? existing.name,
      aliases: patch.aliases ?? existing.aliases,
      title: patch.title ?? existing.title,
      description: patch.description ?? existing.description,
      command: patch.command ?? existing.command,
      parameters: patch.parameters ?? existing.parameters,
      timeoutSeconds: patch.timeoutSeconds ?? existing.timeoutSeconds,
      enabled: patch.enabled ?? existing.enabled,
      telegramEnabled: patch.telegramEnabled ?? existing.telegramEnabled,
      riskFlags: patch.riskFlags ?? existing.riskFlags,
    });
    if (!input) return invalidDefinition(reply, [{ field: 'body', message: '命令定义格式无效。' }]);
    const issues = validateCommandDefinitionInput(input);
    const conflicts = definitions.findTokenConflicts({
      scope: existing.scope,
      projectId: existing.projectId,
      tokens: [input.name, ...(input.aliases ?? [])],
      excludeCommandId: existing.id,
    });
    if (conflicts.length > 0) {
      return reply.code(409).send({
        error: 'ZEUS_COMMAND_TOKEN_CONFLICT',
        message: `名称或别名与 ${conflicts[0]!.commandName} 冲突。`,
        conflicts,
      });
    }
    if (issues.length > 0) return invalidDefinition(reply, issues);
    const mutation = commandApplication.executeCore({
      parsed,
      destinationId: 'command-center-definition-application',
      resourceId: existing.id,
      mutateBusinessState: () => {
        const updated = definitions.update(existing.id, { ...input, revision: existing.revision + 1 });
        options.appendAuditLog({
          ...commandAuditActor(parsed),
          action: 'command.definition.updated',
          resourceType: 'command_definition',
          resourceId: updated.id,
          payload: definitionAuditPayload(updated),
        });
        return updated;
      },
    });
    if (!mutation.replayed) {
      invalidateCommandConfirmations(existing.id, '命令定义已变化');
      options.publishRealtimeEvent('command.definition.updated', definitionEventPayload(mutation.result));
      await options.save();
    }
    return mutation.result;
  }

  async function deleteDefinition(expectedScope: CommandScope, expectedProjectId: string | null, commandId: string, request: CommandCenterMutationRequest<EmptyCommandCenterInput>, reply: FastifyReply): Promise<CommandDefinition | unknown> {
    const parsed = commandApplication.parse<EmptyCommandCenterInput>({
      value: request,
      commandType: commandCenterCommandTypes.definitionDelete,
      scopeKind: 'command_definition',
      expectedScopeId: () => commandId,
    });
    const replay = replayAcceptedCoreCommand<CommandDefinition>(parsed, commandId);
    if (replay) return replay.result;
    const existing = definitions.getById(commandId);
    if (!existing || existing.scope !== expectedScope || existing.projectId !== expectedProjectId) {
      return notFound(reply, 'ZEUS_COMMAND_NOT_FOUND', 'Command definition not found');
    }
    assertExpectedRevision(existing.revision, parsed.command.expectedRevision, parsed.command.scope);
    const mutation = commandApplication.executeCore({
      parsed,
      destinationId: 'command-center-definition-application',
      resourceId: commandId,
      mutateBusinessState: () => {
        definitions.delete(existing.id);
        options.appendAuditLog({
          ...commandAuditActor(parsed),
          action: 'command.definition.deleted',
          resourceType: 'command_definition',
          resourceId: existing.id,
          payload: definitionAuditPayload(existing),
        });
        return existing;
      },
    });
    if (!mutation.replayed) {
      invalidateCommandConfirmations(commandId, '命令定义已删除');
      options.publishRealtimeEvent('command.definition.deleted', definitionEventPayload(mutation.result));
      await options.save();
    }
    return mutation.result;
  }

  async function createConfirmation(projectId: string, commandId: string, request: CommandCenterMutationRequest<CommandConfirmationBody>, reply: FastifyReply): Promise<CommandConfirmation | unknown> {
    const parsed = commandApplication.parse<CommandConfirmationBody>({
      value: request,
      commandType: commandCenterCommandTypes.confirmationCreate,
      scopeKind: 'command_run',
      expectedScopeId: ({ operationIdentity }) => operationIdentity,
    });
    assertCreateRevision(parsed);
    const replay = replayAcceptedCoreCommand<CommandConfirmation & { runId: string }>(parsed, parsed.operationIdentity);
    if (replay) return reply.code(201).send(replay.result);
    const project = requireProject(projectId, reply);
    if (!project) return;
    const command = definitions.getById(commandId);
    if (!command || (command.scope === 'project' && command.projectId !== projectId)) {
      return notFound(reply, 'ZEUS_COMMAND_NOT_FOUND', 'Command definition not found');
    }
    if (!command.enabled) return reply.code(409).send({ error: 'ZEUS_COMMAND_DISABLED', message: 'Command is disabled' });
    const permissionError = commandPermissionError(projectId, command);
    if (permissionError) return reply.code(403).send(permissionError);
    const parameters = normalizeRunParameters(command.parameters, parsed.input.parameters ?? {});
    if ('issues' in parameters) return reply.code(400).send({ error: 'ZEUS_INVALID_COMMAND_PARAMETERS', message: 'Command parameters are invalid', issues: parameters.issues });
    const riskLevel = commandNeedsHighRiskConfirmation(command.riskFlags) ? 'high' : 'normal';
    const trigger = parsed.input.trigger === 'telegram' ? 'telegram' : 'desktop';
    const parameterSnapshot = nonSensitiveParameterSnapshot(command.parameters, parameters.values);
    const createdAt = now();
    const confirmation: StoredCommandConfirmation = {
      id: stableConfirmationId(parsed.operationIdentity),
      runId: parsed.operationIdentity,
      commandId: command.id,
      projectId,
      commandRevision: command.revision,
      cwd: project.localPath,
      parameterDigest: digestParameters(parameters.values),
      riskLevel,
      expiresAt: new Date(createdAt.getTime() + confirmationTtlMs).toISOString(),
      normalizedParameters: parameters.values,
      sensitiveValues: sensitiveParameterValues(command.parameters, parameters.values),
    };
    const publicConfirmation = toPublicConfirmation(confirmation);
    const mutation = commandApplication.executeCore({
      parsed,
      destinationId: 'command-center-confirmation-application',
      resourceId: parsed.operationIdentity,
      mutateBusinessState: () => {
        runs.create({
          id: parsed.operationIdentity,
          commandId: command.id,
          projectId,
          trigger,
          status: 'pending_confirmation',
          commandSnapshot: command,
          parameterSnapshot,
          cwd: project.localPath,
          timeoutSeconds: command.timeoutSeconds,
        });
        options.appendAuditLog({
          ...commandAuditActor(parsed),
          action: 'command.confirmation.created',
          resourceType: 'command_confirmation',
          resourceId: confirmation.id,
          payload: {
            runId: confirmation.runId,
            commandId: command.id,
            commandRevision: command.revision,
            projectId,
            cwd: project.localPath,
            parameterKeys: Object.keys(parameters.values),
            riskLevel,
            expiresAt: confirmation.expiresAt,
          },
        });
        return publicConfirmation;
      },
    });
    if (!mutation.replayed) {
      confirmations.set(confirmation.id, confirmation);
      options.publishRealtimeEvent('command.confirmation.created', {
        confirmationId: confirmation.id,
        runId: confirmation.runId,
        commandId: command.id,
        projectId,
        riskLevel,
      });
      await options.save();
    }
    return reply.code(201).send(mutation.result);
  }

  async function startRun(projectId: string, commandId: string, request: CommandCenterMutationRequest<CommandRunBody>, reply: FastifyReply): Promise<CommandRun | unknown> {
    const parsed = commandApplication.parse<CommandRunBody>({
      value: request,
      commandType: commandCenterCommandTypes.runStart,
      scopeKind: 'command_run',
    });
    const runId = requiredInputIdentity(parsed.input.runId, 'input.runId');
    if (parsed.command.scope.id !== runId) throw new CommandCenterCommandApplicationError('ZEUS_COMMAND_CENTER_COMMAND_INVALID', 'Run start command scope must match input.runId.', 400);
    assertCreateRevision(parsed);
    const externalOperationId = `command-run-start:${runId}`;
    const acceptedReplay = replayAcceptedExternalCommand<CommandRun>(parsed, runId, externalOperationId);
    if (acceptedReplay) return reply.code(201).send(acceptedReplay.result);
    const project = requireProject(projectId, reply);
    if (!project) return;
    const command = definitions.getById(commandId);
    if (!command || (command.scope === 'project' && command.projectId !== projectId)) {
      return notFound(reply, 'ZEUS_COMMAND_NOT_FOUND', 'Command definition not found');
    }
    const confirmationId = requiredInputIdentity(parsed.input.confirmationId, 'input.confirmationId');
    const confirmation = confirmations.get(confirmationId);
    const pendingRun = runs.getById(runId);
    if (!confirmation) {
      return rejectRunStart({
        parsed,
        run: pendingRun,
        externalOperationId,
        error: 'ZEUS_COMMAND_CONFIRMATION_REQUIRED',
        message: 'A valid command confirmation is required',
        statusCode: 400,
        reason: '命令确认不存在或 Zeus 重启后已失效',
        reply,
      });
    }
    if (confirmation.runId !== runId || !pendingRun || pendingRun.id !== confirmation.runId) {
      return rejectRunStart({
        parsed,
        run: pendingRun,
        confirmation,
        externalOperationId,
        error: 'ZEUS_COMMAND_CONFIRMATION_STALE',
        message: 'Command confirmation does not match the addressed run',
        statusCode: 409,
        reason: '命令确认与执行身份不一致',
        reply,
      });
    }
    if (Date.parse(confirmation.expiresAt) <= now().getTime()) {
      return rejectRunStart({
        parsed,
        run: pendingRun,
        confirmation,
        externalOperationId,
        error: 'ZEUS_COMMAND_CONFIRMATION_STALE',
        message: 'Command confirmation has expired',
        statusCode: 409,
        reason: '命令确认已过期',
        reply,
      });
    }
    const parameters = normalizeRunParameters(command.parameters, parsed.input.parameters ?? {});
    if ('issues' in parameters) {
      return rejectRunStart({
        parsed,
        run: pendingRun,
        confirmation,
        externalOperationId,
        error: 'ZEUS_INVALID_COMMAND_PARAMETERS',
        message: 'Command parameters are invalid',
        statusCode: 400,
        reason: '命令参数已变化',
        details: { issues: parameters.issues },
        reply,
      });
    }
    const unchanged =
      command.enabled &&
      confirmation.commandId === command.id &&
      confirmation.projectId === projectId &&
      confirmation.commandRevision === command.revision &&
      confirmation.cwd === project.localPath &&
      confirmation.parameterDigest === digestParameters(parameters.values);
    if (!unchanged) {
      return rejectRunStart({
        parsed,
        run: pendingRun,
        confirmation,
        externalOperationId,
        error: 'ZEUS_COMMAND_CONFIRMATION_STALE',
        message: 'Command confirmation is no longer valid',
        statusCode: 409,
        reason: '命令、项目、目录或参数在确认后发生变化',
        reply,
      });
    }
    const permissionError = commandPermissionError(projectId, command);
    if (permissionError) {
      return rejectRunStart({
        parsed,
        run: pendingRun,
        confirmation,
        externalOperationId,
        error: permissionError.error,
        message: permissionError.message,
        statusCode: 403,
        reason: permissionError.message,
        reply,
      });
    }
    const preparation = commandApplication.prepareExternal<CommandRunBody, CommandRun>({
      parsed,
      destinationId: 'command-center-runtime',
      resourceId: runId,
      externalOperationId,
      mutatePreparedBusinessState: () => {
        const starting = runs.update(runId, { status: 'starting', failureReason: null });
        appendRunAudit('command.run.starting', starting, parsed);
      },
    });
    if (preparation.state === 'accepted_replay') return reply.code(201).send(preparation.acceptedReplayResult);
    const starting = runs.getById(runId)!;
    commandApplication.markExternalWriteStarted(preparation);
    confirmations.delete(confirmation.id);
    let releaseNotesCapability: { url: string; token: string } | undefined;
    let session: AiRuntimeSession;
    try {
      publishRun('command.run.starting', starting);
      const runDirectory = commandRunDirectory(runId);
      mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
      releaseNotesCapability = isReleaseCommand(command.command) ? options.createReleaseNotesCapability?.({ runId, projectId }) : undefined;
      const environment = {
        ...options.buildRuntimeProcessEnv(),
        ...parameterEnvironment(command.parameters, parameters.values),
        ZEUS_PROJECT_ROOT: project.localPath,
        ZEUS_COMMAND_SCRIPTS_DIR: options.commandScriptsDirectory,
        ZEUS_COMMAND_RUN_DIR: runDirectory,
        ZEUS_COMMAND_ID: command.id,
        ZEUS_COMMAND_RUN_ID: runId,
        ...(releaseNotesCapability
          ? {
              ZEUS_RELEASE_NOTES_API_URL: releaseNotesCapability.url,
              ZEUS_RELEASE_NOTES_CAPABILITY: releaseNotesCapability.token,
            }
          : {}),
      };
      session = await options.aiRuntimeManager.startSession({
        projectId,
        command: 'sh',
        args: ['-lc', command.command],
        cwd: project.localPath,
        env: environment,
        redactValues: [...confirmation.sensitiveValues, ...(releaseNotesCapability ? [releaseNotesCapability.token] : [])],
      });
    } catch (error) {
      options.revokeReleaseNotesCapability?.(runId);
      const failureMessage = error instanceof Error ? error.message : String(error);
      const unknown = commandApplication.resolveExternal({
        preparation,
        outcome: 'outcome_unknown_after_write',
        evidence: { failureMessage, boundary: 'after_external_write_marker' },
        mutateBusinessState: () => {
          const unresolved = runs.update(runId, { status: 'starting', failureReason: `启动结果未知：${failureMessage}` });
          appendRunAudit('command.run.start_outcome_unknown', unresolved, parsed);
          return unresolved;
        },
      });
      publishRun('command.run.start_outcome_unknown', unknown.result);
      await options.save();
      return reply.code(503).send({ error: 'ZEUS_COMMAND_RUN_OUTCOME_UNKNOWN', message: unknown.result.failureReason, run: unknown.result });
    }
    const startedAt = now().toISOString();
    const accepted = commandApplication.resolveExternal({
      preparation,
      outcome: 'accepted',
      evidence: { runtimeSessionId: session.id, startedAt },
      mutateBusinessState: () => {
        const updated = runs.update(runId, { status: 'running', runtimeSessionId: session.id, startedAt, failureReason: null });
        appendRunAudit('command.run.started', updated, parsed);
        return updated;
      },
    });
    publishRun('command.run.started', accepted.result);
    scheduleRunTimeout(accepted.result);
    handleRuntimeSessionChange(session);
    await options.save();
    return reply.code(201).send(accepted.result);
  }

  async function stopRun(runId: string, request: CommandCenterMutationRequest<EmptyCommandCenterInput>, reply: FastifyReply): Promise<CommandRun | unknown> {
    const parsed = commandApplication.parse<EmptyCommandCenterInput>({
      value: request,
      commandType: commandCenterCommandTypes.runStop,
      scopeKind: 'command_run',
      expectedScopeId: () => runId,
    });
    assertCreateRevision(parsed);
    const externalOperationId = `command-run-stop:${runId}`;
    const acceptedReplay = replayAcceptedExternalCommand<CommandRun>(parsed, runId, externalOperationId);
    if (acceptedReplay) return acceptedReplay.result;
    const run = runs.getById(runId);
    if (!run) return notFound(reply, 'ZEUS_COMMAND_RUN_NOT_FOUND', 'Command run not found');
    if (run.status !== 'running' || !run.runtimeSessionId) {
      return reply.code(409).send({ error: 'ZEUS_COMMAND_RUN_NOT_RUNNING', message: 'Command run is not running' });
    }
    const runtimeSessionId = run.runtimeSessionId;
    const preparation = commandApplication.prepareExternal<EmptyCommandCenterInput, CommandRun>({
      parsed,
      destinationId: 'command-center-runtime',
      resourceId: runId,
      externalOperationId,
      mutatePreparedBusinessState: () => {
        const stopping = runs.update(runId, { status: 'stopping', failureReason: null });
        appendRunAudit('command.run.stopping', stopping, parsed);
      },
    });
    if (preparation.state === 'accepted_replay') return preparation.acceptedReplayResult;
    const stopping = runs.getById(runId)!;
    commandApplication.markExternalWriteStarted(preparation);
    clearRunTimeout(run.id);
    options.revokeReleaseNotesCapability?.(run.id);
    try {
      publishRun('command.run.stopping', stopping);
      options.aiRuntimeManager.stopSession(runtimeSessionId);
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      const unknown = commandApplication.resolveExternal({
        preparation,
        outcome: 'outcome_unknown_after_write',
        evidence: { runtimeSessionId, failureMessage, boundary: 'after_external_write_marker' },
        mutateBusinessState: () => {
          const unresolved = runs.update(runId, { status: 'stopping', failureReason: `停止结果未知：${failureMessage}` });
          appendRunAudit('command.run.stop_outcome_unknown', unresolved, parsed);
          return unresolved;
        },
      });
      publishRun('command.run.stop_outcome_unknown', unknown.result);
      await options.save();
      return reply.code(503).send({ error: 'ZEUS_COMMAND_RUN_OUTCOME_UNKNOWN', message: unknown.result.failureReason, run: unknown.result });
    }
    const endedAt = now().toISOString();
    const accepted = commandApplication.resolveExternal({
      preparation,
      outcome: 'accepted',
      evidence: { runtimeSessionId, endedAt },
      mutateBusinessState: () => {
        const updated = runs.update(runId, { status: 'cancelled', endedAt, failureReason: '用户停止执行' });
        appendRunAudit('command.run.cancelled', updated, parsed);
        return updated;
      },
    });
    scheduleForceKill(run.id, runtimeSessionId);
    publishRun('command.run.cancelled', accepted.result);
    await options.save();
    return accepted.result;
  }

  async function rejectRunStart(input: {
    parsed: ParsedCommandCenterMutation<CommandRunBody>;
    run: CommandRun | undefined;
    confirmation?: StoredCommandConfirmation;
    externalOperationId: string;
    error: string;
    message: string;
    statusCode: 400 | 403 | 409;
    reason: string;
    details?: Record<string, unknown>;
    reply: FastifyReply;
  }): Promise<unknown> {
    const preparation = commandApplication.prepareExternal<CommandRunBody, { run: CommandRun | null }>({
      parsed: input.parsed,
      destinationId: 'command-center-runtime',
      resourceId: input.parsed.command.scope.id,
      externalOperationId: input.externalOperationId,
    });
    if (preparation.state === 'accepted_replay') return input.reply.code(201).send(preparation.acceptedReplayResult.run);
    const rejected = commandApplication.resolveExternal({
      preparation,
      outcome: 'explicitly_rejected',
      evidence: { error: input.error, reason: input.reason },
      mutateBusinessState: () => {
        const current = input.run ? runs.getById(input.run.id) : undefined;
        if (!current || current.status !== 'pending_confirmation') return { run: current ?? null };
        const updated = runs.update(current.id, { status: 'rejected', failureReason: input.reason, endedAt: now().toISOString() });
        appendRunAudit('command.confirmation.rejected', updated, input.parsed);
        return { run: updated };
      },
    });
    if (input.confirmation) confirmations.delete(input.confirmation.id);
    if (rejected.result.run) publishRun('command.confirmation.rejected', rejected.result.run);
    await options.save();
    return input.reply.code(input.statusCode).send({ error: input.error, message: input.message, ...(input.details ?? {}), run: rejected.result.run });
  }

  function handleRuntimeSessionChange(session: AiRuntimeSession): void {
    const run = runs.getByRuntimeSessionId(session.id);
    if (!run || session.status === 'running') return;
    if (run.status !== 'running') {
      clearForceKill(run.id);
      return;
    }
    clearRunTimeout(run.id);
    options.revokeReleaseNotesCapability?.(run.id);
    const endedAt = session.endedAt ?? now().toISOString();
    const readableFailure = extractReadableReleaseFailure(artifactBuffers.get(session.id) ?? '');
    const next =
      session.status === 'exited' && session.exitCode === 0
        ? { status: 'succeeded' as const, exitCode: 0, endedAt, failureReason: null }
        : session.status === 'stopped'
          ? { status: 'cancelled' as const, exitCode: session.exitCode ?? null, endedAt, failureReason: '执行已停止' }
          : {
              status: 'failed' as const,
              exitCode: session.exitCode ?? null,
              endedAt,
              failureReason: readableFailure ?? (session.status === 'failed' ? 'Runtime 执行失败；请展开原始日志查看失败命令和恢复建议。' : `命令退出码 ${session.exitCode ?? 'unknown'}；请展开原始日志查看原因。`),
            };
    const updated = runs.update(run.id, next);
    registerRuntimeLogArtifacts(updated, session.id);
    appendRunAudit(`command.run.${updated.status}`, updated);
    publishRun(`command.run.${updated.status}`, updated);
  }

  function handleRuntimeLog(log: AiRuntimeLogEntry): void {
    const run = runs.getByRuntimeSessionId(log.sessionId);
    if (!run) return;
    const buffered = `${artifactBuffers.get(log.sessionId) ?? ''}${log.text}`.slice(-8192);
    artifactBuffers.set(log.sessionId, buffered);
    for (const marker of buffered.matchAll(/(?:^|\r?\n)ZEUS_ARTIFACT_FILE=([^\r\n]+)/gu)) {
      const rawPath = marker[1]?.trim().replace(/^['"]|['"]$/gu, '');
      if (!rawPath) continue;
      registerArtifact(run, rawPath);
    }
  }

  function registerArtifact(run: CommandRun, rawPath: string): void {
    const runDirectory = commandRunDirectory(run.id);
    const candidate = isAbsolute(rawPath) ? rawPath : resolve(runDirectory, rawPath);
    const verified = verifyArtifactPath(candidate, runDirectory);
    if (!verified) {
      options.appendAuditLog({
        actorType: 'runtime',
        action: 'command.artifact.rejected',
        resourceType: 'command_run',
        resourceId: run.id,
        payload: { runId: run.id, requestedPath: rawPath, reason: 'outside_run_directory_or_not_file' },
      });
      return;
    }
    const relativePath = relative(realpathSync(runDirectory), verified).replace(/\\/gu, '/');
    const artifact = artifacts.createFromFile({
      runId: run.id,
      projectId: run.projectId,
      relativePath,
      sourcePath: verified,
      mimeType: mimeTypeForPath(verified),
    });
    options.appendAuditLog({
      actorType: 'runtime',
      action: 'command.artifact.registered',
      resourceType: 'command_artifact',
      resourceId: artifact.id,
      payload: { runId: run.id, relativePath: artifact.relativePath, byteLength: artifact.byteLength, mimeType: artifact.mimeType },
    });
    options.publishRealtimeEvent('command.artifact.registered', {
      runId: run.id,
      artifactId: artifact.id,
      relativePath: artifact.relativePath,
      mimeType: artifact.mimeType,
    });
  }

  function registerRuntimeLogArtifacts(run: CommandRun, sessionId: string): void {
    for (const descriptor of options.resolveRuntimeSessionLogFiles?.(sessionId) ?? []) {
      try {
        const artifact = artifacts.createFromFile({
          runId: run.id,
          projectId: run.projectId,
          relativePath: descriptor.relativePath,
          sourcePath: descriptor.sourcePath,
          mimeType: descriptor.mimeType,
        });
        options.appendAuditLog({
          actorType: 'runtime',
          action: 'command.log_artifact.registered',
          resourceType: 'command_artifact',
          resourceId: artifact.id,
          payload: { runId: run.id, sessionId, relativePath: artifact.relativePath, byteLength: artifact.byteLength },
        });
        options.publishRealtimeEvent('command.log_artifact.registered', {
          runId: run.id,
          sessionId,
          artifactId: artifact.id,
          relativePath: artifact.relativePath,
        });
      } catch (error) {
        options.appendAuditLog({
          actorType: 'runtime',
          action: 'command.log_artifact.failed',
          resourceType: 'command_run',
          resourceId: run.id,
          payload: { runId: run.id, sessionId, relativePath: descriptor.relativePath, message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
  }

  function scheduleRunTimeout(run: CommandRun): void {
    clearRunTimeout(run.id);
    timeoutHandles.set(
      run.id,
      setTimeout(() => {
        const current = runs.getById(run.id);
        if (!current || current.status !== 'running' || !current.runtimeSessionId) return;
        const endedAt = now().toISOString();
        const timedOut = runs.update(current.id, {
          status: 'timed_out',
          endedAt,
          failureReason: `执行超过 ${current.timeoutSeconds} 秒`,
        });
        options.aiRuntimeManager.stopSession(current.runtimeSessionId);
        scheduleForceKill(current.id, current.runtimeSessionId);
        appendRunAudit('command.run.timed_out', timedOut);
        publishRun('command.run.timed_out', timedOut);
        void options.save();
      }, run.timeoutSeconds * 1000),
    );
  }

  function scheduleForceKill(runId: string, sessionId: string): void {
    const existing = forceKillHandles.get(runId);
    if (existing) clearTimeout(existing);
    forceKillHandles.set(
      runId,
      setTimeout(() => {
        forceKillHandles.delete(runId);
        try {
          options.aiRuntimeManager.killSession(sessionId, 'SIGKILL');
        } catch {
          // 子进程已退出时无需升级为错误；命令终态已经由 run 记录保存。
        }
      }, 3_000),
    );
  }

  function clearForceKill(runId: string): void {
    const timeout = forceKillHandles.get(runId);
    if (timeout) clearTimeout(timeout);
    forceKillHandles.delete(runId);
  }

  function clearRunTimeout(runId: string): void {
    const timeout = timeoutHandles.get(runId);
    if (timeout) clearTimeout(timeout);
    timeoutHandles.delete(runId);
  }

  async function runCommandRoute(reply: FastifyReply, operation: () => unknown | Promise<unknown>): Promise<unknown> {
    try {
      return await operation();
    } catch (error) {
      if (!isCommandCenterCommandError(error)) throw error;
      const statusCode = commandCenterCommandErrorStatus(error);
      return reply.code(statusCode).send({
        error: error.code,
        message: error.message,
        ...('details' in error ? { details: error.details } : {}),
      });
    }
  }

  function replayAcceptedCoreCommand<TResult>(parsed: ParsedCommandCenterMutation<object>, resourceId: string) {
    const latest = options.commandDeliveries.get(parsed.command.commandId)?.attempts.at(-1);
    if (latest?.destinationKind !== 'core_application' || latest.outcome !== 'accepted' || !latest.receipt) return undefined;
    return commandApplication.executeCore({
      parsed,
      destinationId: latest.destinationId,
      resourceId,
      mutateBusinessState: () => {
        throw new Error('Accepted Core command replay must never execute its mutation.');
      },
    }) as ReturnType<CommandCenterCommandApplication['executeCore']> & { result: TResult };
  }

  function replayAcceptedExternalCommand<TResult>(parsed: ParsedCommandCenterMutation<object>, resourceId: string, externalOperationId: string) {
    const latest = options.commandDeliveries.get(parsed.command.commandId)?.attempts.at(-1);
    if (latest?.destinationKind !== 'external_operation' || latest.outcome !== 'accepted' || !latest.receipt) return undefined;
    const replay = commandApplication.prepareExternal<object, TResult>({
      parsed,
      destinationId: latest.destinationId,
      resourceId,
      externalOperationId,
    });
    if (replay.state !== 'accepted_replay') throw new Error('Accepted external command did not return its immutable replay result.');
    return { result: replay.acceptedReplayResult };
  }

  function invalidateCommandConfirmations(commandId: string, reason: string): void {
    for (const confirmation of confirmations.values()) {
      if (confirmation.commandId === commandId) rejectConfirmation(confirmation, reason);
    }
  }

  function rejectConfirmation(confirmation: StoredCommandConfirmation, reason: string): void {
    confirmations.delete(confirmation.id);
    const run = runs.getById(confirmation.runId);
    if (!run || run.status !== 'pending_confirmation') return;
    const rejected = runs.update(run.id, { status: 'rejected', failureReason: reason, endedAt: now().toISOString() });
    appendRunAudit('command.confirmation.rejected', rejected);
    publishRun('command.confirmation.rejected', rejected);
  }

  function requireProject(projectId: string, reply: FastifyReply) {
    const project = options.projects.getById(projectId);
    if (!project) {
      notFound(reply, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
      return undefined;
    }
    return project;
  }

  function commandPermissionError(projectId: string, command: CommandDefinition): { error: string; message: string } | null {
    const security = options.readProjectSecurity(projectId);
    if (!security.allowShell) {
      return { error: 'ZEUS_COMMAND_SHELL_PERMISSION_REQUIRED', message: 'Project must enable allowShell before commands can run' };
    }
    if (command.riskFlags.gitWrite && !security.allowGitWrite) {
      return { error: 'ZEUS_COMMAND_GIT_WRITE_PERMISSION_REQUIRED', message: 'Project must enable allowGitWrite before this command can run' };
    }
    return null;
  }

  function appendRunAudit(action: string, run: CommandRun, parsed?: ParsedCommandCenterMutation<object>): void {
    options.appendAuditLog({
      ...(parsed ? commandAuditActor(parsed) : { actorType: run.trigger }),
      action,
      resourceType: 'command_run',
      resourceId: run.id,
      payload: {
        runId: run.id,
        commandId: run.commandId,
        commandName: run.commandSnapshot.name,
        commandRevision: run.commandSnapshot.revision,
        projectId: run.projectId,
        runtimeSessionId: run.runtimeSessionId,
        cwd: run.cwd,
        status: run.status,
        parameterKeys: Object.keys(run.parameterSnapshot),
        timeoutSeconds: run.timeoutSeconds,
        exitCode: run.exitCode,
      },
    });
  }

  function publishRun(type: string, run: CommandRun): void {
    options.publishRealtimeEvent(type, {
      runId: run.id,
      commandId: run.commandId,
      commandName: run.commandSnapshot.name,
      projectId: run.projectId,
      runtimeSessionId: run.runtimeSessionId,
      status: run.status,
    });
  }

  function findArtifactById(artifactId: string) {
    return artifacts.getById(artifactId);
  }

  function commandRunDirectory(runId: string): string {
    return join(options.commandRunsDirectory, runId);
  }

  function recoverInterruptedRuns(): void {
    let changed = false;
    for (const run of runs.listActive()) {
      const endedAt = now().toISOString();
      if (run.status === 'pending_confirmation') {
        const updated = runs.update(run.id, {
          status: 'rejected',
          endedAt,
          failureReason: 'Zeus 重启后原确认已失效',
        });
        appendRunAudit('command.run.rejected', updated);
        publishRun('command.run.rejected', updated);
        changed = true;
        continue;
      }
      const runtimeStatus = run.runtimeSessionId ? options.runtimeSessions.getById(run.runtimeSessionId)?.status : undefined;
      const updated = runs.update(run.id, {
        status: 'failed',
        endedAt,
        failureReason: `Zeus 重启中断执行${runtimeStatus ? `（Runtime：${runtimeStatus}）` : ''}`,
      });
      appendRunAudit('command.run.failed', updated);
      publishRun('command.run.failed', updated);
      changed = true;
    }
    if (changed) void options.save();
  }

  function stopActiveRuns(reason: string): number {
    let stopped = 0;
    for (const run of runs.listActive()) {
      clearRunTimeout(run.id);
      clearForceKill(run.id);
      options.revokeReleaseNotesCapability?.(run.id);
      const endedAt = now().toISOString();
      const updated = runs.update(run.id, {
        status: 'cancelled',
        endedAt,
        failureReason: reason,
      });
      if (run.runtimeSessionId) {
        options.aiRuntimeManager.stopSession(run.runtimeSessionId);
        options.aiRuntimeManager.killSession(run.runtimeSessionId, 'SIGKILL');
      }
      appendRunAudit('command.run.cancelled', updated);
      publishRun('command.run.cancelled', updated);
      stopped += 1;
    }
    return stopped;
  }

  function close(): void {
    for (const timeout of timeoutHandles.values()) clearTimeout(timeout);
    for (const timeout of forceKillHandles.values()) clearTimeout(timeout);
    if (!options.readOnlyValidation) {
      for (const runId of forceKillHandles.keys()) {
        const run = runs.getById(runId);
        if (run?.runtimeSessionId) {
          try {
            options.aiRuntimeManager.killSession(run.runtimeSessionId, 'SIGKILL');
          } catch {
            // 已退出的子进程无需在关闭流程中升级成错误。
          }
        }
      }
      for (const run of runs.listActive()) {
        options.revokeReleaseNotesCapability?.(run.id);
        if (run.status !== 'running' || !run.runtimeSessionId) continue;
        try {
          options.aiRuntimeManager.killSession(run.runtimeSessionId, 'SIGKILL');
        } catch {
          // 已退出的子进程无需在关闭流程中升级成错误。
        }
      }
    }
    timeoutHandles.clear();
    forceKillHandles.clear();
    confirmations.clear();
    artifactBuffers.clear();
  }

  return { handleRuntimeSessionChange, handleRuntimeLog, stopActiveRuns, close };
}

function definitionCreateScopeId(scope: CommandScope, projectId: string | null, operationIdentity: string): string {
  return scope === 'global' ? `global:${operationIdentity}` : `project:${projectId ?? 'missing'}:${operationIdentity}`;
}

function assertCreateRevision(parsed: ParsedCommandCenterMutation<object>): void {
  if (parsed.command.expectedRevision === null) return;
  throw new CommandCenterCommandApplicationError('ZEUS_COMMAND_CENTER_COMMAND_INVALID', 'Create/action Command expectedRevision must be null.', 409);
}

function requiredInputIdentity(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 512 ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw new CommandCenterCommandApplicationError('ZEUS_COMMAND_CENTER_COMMAND_INVALID', `${field} is invalid.`, 400);
  }
  return value;
}

function stableConfirmationId(operationIdentity: string): string {
  return `command_confirmation_${createHash('sha256').update(operationIdentity).digest('hex').slice(0, 32)}`;
}

function commandAuditActor(parsed: ParsedCommandCenterMutation<object>): { actorType: string; actorRef?: string } {
  return {
    actorType: parsed.command.actor.kind,
    ...(parsed.command.actor.id ? { actorRef: parsed.command.actor.id } : {}),
  };
}

function commandCenterCommandErrorStatus(error: { code: string }): 400 | 404 | 409 | 500 | 503 {
  if (error instanceof CommandCenterCommandApplicationError) return error.statusCode;
  if (error.code === 'ZEUS_COMMAND_ENVELOPE_INVALID' || error.code === 'ZEUS_COMMAND_ENVELOPE_SCHEMA_MISMATCH' || error.code === 'ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT') return 400;
  if (error.code === 'ZEUS_COMMAND_DELIVERY_NOT_FOUND') return 404;
  if (error.code === 'ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT') return 503;
  return error.code === 'ZEUS_COMMAND_CENTER_RESULT_MISSING' ? 500 : 409;
}

function extractReadableReleaseFailure(raw: string): string | null {
  const output = projectTerminalOutput(raw);
  const marker = '\n发布失败\n';
  const markerIndex = `\n${output}`.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const block = `\n${output}`
    .slice(markerIndex + 1)
    .split(/\n(?=\s*ELIFECYCLE\b|npm error\b)/u, 1)[0]
    ?.trim();
  return block ? block.slice(0, 2_000) : null;
}

function isReleaseCommand(command: string): boolean {
  return /^pnpm(?:\s+run)?\s+release$/u.test(command.trim());
}

function normalizeDefinitionInput(input: CommandDefinitionInput | undefined): CommandDefinitionInput | null {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.name !== 'string' || typeof input.title !== 'string' || typeof input.command !== 'string') return null;
  if (input.description !== undefined && typeof input.description !== 'string') return null;
  if (input.aliases !== undefined && (!Array.isArray(input.aliases) || !input.aliases.every((alias) => typeof alias === 'string'))) return null;
  if (input.parameters !== undefined && (!Array.isArray(input.parameters) || !input.parameters.every(isCommandParameterDefinition))) return null;
  if (input.timeoutSeconds !== undefined && typeof input.timeoutSeconds !== 'number') return null;
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return null;
  if (input.telegramEnabled !== undefined && typeof input.telegramEnabled !== 'boolean') return null;
  if (input.riskFlags !== undefined && (!input.riskFlags || typeof input.riskFlags !== 'object' || Array.isArray(input.riskFlags))) return null;
  for (const key of ['gitWrite', 'outsideProjectWrite', 'externalServiceWrite'] as const) {
    if (input.riskFlags?.[key] !== undefined && typeof input.riskFlags[key] !== 'boolean') return null;
  }
  return {
    name: input.name.trim(),
    aliases: (input.aliases ?? []).map((alias) => alias.trim()),
    title: input.title.trim(),
    description: input.description?.trim() ?? '',
    command: input.command.trim(),
    parameters: input.parameters ?? [],
    timeoutSeconds: input.timeoutSeconds ?? 300,
    enabled: input.enabled ?? true,
    telegramEnabled: input.telegramEnabled ?? false,
    riskFlags: { ...defaultCommandRiskFlags, ...(input.riskFlags ?? {}) },
  };
}

function isCommandParameterDefinition(value: unknown): value is CommandParameterDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const parameter = value as Partial<CommandParameterDefinition>;
  return (
    typeof parameter.key === 'string' &&
    typeof parameter.label === 'string' &&
    typeof parameter.description === 'string' &&
    (parameter.type === 'string' || parameter.type === 'number' || parameter.type === 'boolean') &&
    typeof parameter.required === 'boolean' &&
    typeof parameter.sensitive === 'boolean'
  );
}

function normalizeRunParameters(definitions: CommandParameterDefinition[], rawValues: Record<string, unknown>): { values: Record<string, string | number | boolean> } | { issues: Array<{ field: string; message: string }> } {
  if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues)) {
    return { issues: [{ field: 'parameters', message: '参数必须是对象。' }] };
  }
  const declaredKeys = new Set(definitions.map((definition) => definition.key));
  const unknownKeys = Object.keys(rawValues).filter((key) => !declaredKeys.has(key));
  const issues = unknownKeys.map((key) => ({ field: key, message: '参数未在命令中声明。' }));
  const values: Record<string, string | number | boolean> = {};
  for (const definition of definitions) {
    const rawValue = rawValues[definition.key] ?? definition.defaultValue;
    const missing = rawValue === undefined || (definition.type === 'string' && rawValue === '');
    if (missing) {
      if (definition.required) issues.push({ field: definition.key, message: '参数为必填项。' });
      continue;
    }
    if (!commandParameterValueMatchesType(rawValue, definition.type)) {
      issues.push({ field: definition.key, message: `参数类型必须是 ${definition.type}。` });
      continue;
    }
    values[definition.key] = rawValue;
  }
  return issues.length > 0 ? { issues } : { values };
}

function nonSensitiveParameterSnapshot(definitions: CommandParameterDefinition[], values: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const snapshot: Record<string, string | number | boolean> = {};
  for (const definition of definitions) {
    if (definition.sensitive || values[definition.key] === undefined) continue;
    snapshot[definition.key] = values[definition.key]!;
  }
  return snapshot;
}

function sensitiveParameterValues(definitions: CommandParameterDefinition[], values: Record<string, string | number | boolean>): string[] {
  return definitions
    .filter((definition) => definition.sensitive && values[definition.key] !== undefined)
    .map((definition) => String(values[definition.key]))
    .filter((value) => value.length > 0);
}

function parameterEnvironment(definitions: CommandParameterDefinition[], values: Record<string, string | number | boolean>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const definition of definitions) {
    const value = values[definition.key];
    if (value === undefined) continue;
    environment[definition.key] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
  }
  return environment;
}

function digestParameters(values: Record<string, string | number | boolean>): string {
  const ordered = Object.keys(values)
    .sort()
    .map((key) => [key, values[key]]);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

function toPublicConfirmation(confirmation: StoredCommandConfirmation): CommandConfirmation & { runId: string } {
  return {
    id: confirmation.id,
    runId: confirmation.runId,
    commandId: confirmation.commandId,
    projectId: confirmation.projectId,
    commandRevision: confirmation.commandRevision,
    cwd: confirmation.cwd,
    parameterDigest: confirmation.parameterDigest,
    riskLevel: confirmation.riskLevel,
    expiresAt: confirmation.expiresAt,
  };
}

function toPublicRuntimeSession(record: ZeusRuntimeSessionRecord | undefined): AiRuntimeSession | null {
  if (!record) return null;
  let args: string[] = [];
  try {
    const parsed = JSON.parse(record.argsJson) as unknown;
    if (Array.isArray(parsed)) args = parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    args = [];
  }
  // 只逐字段返回公开投影，进程身份 token 等恢复专用字段绝不能进入命令详情 JSON。
  return {
    id: record.id,
    projectId: record.projectId,
    taskId: record.taskId ?? undefined,
    command: record.command,
    args,
    cwd: record.cwd,
    status: record.status,
    pid: record.pid ?? undefined,
    exitCode: record.exitCode,
    summary: record.summary,
    favorite: record.favorite,
    archived: record.archived,
    deletedAt: record.deletedAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? undefined,
  };
}

function definitionAuditPayload(definition: CommandDefinition): Record<string, unknown> {
  return {
    commandId: definition.id,
    scope: definition.scope,
    projectId: definition.projectId,
    name: definition.name,
    aliases: definition.aliases,
    revision: definition.revision,
    enabled: definition.enabled,
    telegramEnabled: definition.telegramEnabled,
    timeoutSeconds: definition.timeoutSeconds,
    parameterKeys: definition.parameters.map((parameter) => parameter.key),
    riskFlags: definition.riskFlags,
  };
}

function definitionEventPayload(definition: CommandDefinition): Record<string, unknown> {
  return {
    commandId: definition.id,
    scope: definition.scope,
    projectId: definition.projectId,
    name: definition.name,
    revision: definition.revision,
    enabled: definition.enabled,
  };
}

function invalidDefinition(reply: FastifyReply, issues: Array<{ field: string; message: string }>) {
  return reply.code(400).send({ error: 'ZEUS_INVALID_COMMAND_DEFINITION', message: 'Command definition is invalid', issues });
}

function notFound(reply: FastifyReply, error: string, message: string) {
  return reply.code(404).send({ error, message });
}

function verifyArtifactPath(candidatePath: string, runDirectory: string): string | null {
  try {
    if (!existsSync(runDirectory) || !existsSync(candidatePath)) return null;
    const root = realpathSync(runDirectory);
    const candidate = realpathSync(candidatePath);
    const rel = relative(root, candidate);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/** 命令详情是高频轻量投影；巨型原始日志只留在 Runtime，避免单次响应压垮 renderer。 */
function boundCommandRunLogs(items: ZeusRuntimeLogRecord[], afterSeq: number, nextSeq: number): { items: ZeusRuntimeLogRecord[]; truncated: boolean } {
  const contentBudget = MAX_COMMAND_RUN_LOG_PAYLOAD_BYTES - 1_024;
  const selected: ZeusRuntimeLogRecord[] = [];
  let usedBytes = 0;
  let skippedCount = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const itemBytes = Buffer.byteLength(item.text, 'utf8');
    if (itemBytes > contentBudget || usedBytes + itemBytes > contentBudget) {
      skippedCount += 1;
      continue;
    }
    selected.push(item);
    usedBytes += itemBytes;
  }
  selected.reverse();
  if (skippedCount === 0) return { items: selected, truncated: false };
  const reference = items[0];
  if (reference) {
    selected.unshift({
      id: `command_log_budget_${reference.sessionId}_${afterSeq}_${nextSeq}`,
      sessionId: reference.sessionId,
      stream: 'system',
      text: `[命令详情已省略 ${skippedCount} 个超出约 4 MB 展示预算的日志块，完整内容请在 Runtime 日志中查看。]\n`,
      createdAt: reference.createdAt,
    });
  }
  return { items: selected, truncated: true };
}

interface CommandRunOutputProjection {
  content: string;
  byteLength: number;
  exceeded: boolean;
}

/** 按持久序号同步读取一次快照；路由执行期间不让新日志插入当前剪贴板内容。 */
function projectCompleteCommandRunOutput(runtimeSessions: RuntimeSessionRepository, sessionId: string, byteLimit: number): CommandRunOutputProjection {
  const projector = new BoundedTerminalOutputProjector(byteLimit);
  let afterSeq = 0;
  let snapshotLastSeq: number | undefined;
  let hasRawContent = false;
  let lastRawCharacter = '';

  while (true) {
    const remainingEvents = snapshotLastSeq === undefined ? COMMAND_RUN_LOG_COPY_PAGE_SIZE : Math.max(0, snapshotLastSeq - afterSeq);
    if (remainingEvents === 0) break;
    const page = runtimeSessions.searchLogs(sessionId, { afterSeq, limit: Math.min(COMMAND_RUN_LOG_COPY_PAGE_SIZE, remainingEvents) });
    snapshotLastSeq ??= page.total;
    // searchLogs 内部先读 MAX(seq) 再读正文；两条语句之间新增的尾部日志不能混入已冻结快照。
    const snapshotItems = page.items.slice(0, Math.max(0, snapshotLastSeq - afterSeq));
    for (const log of snapshotItems) {
      if (log.stream === 'system' && hasRawContent && lastRawCharacter !== '\n' && lastRawCharacter !== '\r' && !projector.write('\n')) return projector.exceededResult();
      if (log.text && !projector.write(log.text)) return projector.exceededResult();
      if (log.text) {
        hasRawContent = true;
        lastRawCharacter = log.text.at(-1) ?? lastRawCharacter;
      }
      if (log.stream === 'system' && lastRawCharacter !== '\n') {
        if (!projector.write('\n')) return projector.exceededResult();
        hasRawContent = true;
        lastRawCharacter = '\n';
      }
    }
    const snapshotNextSeq = Math.min(page.nextSeq, snapshotLastSeq);
    if (snapshotNextSeq >= snapshotLastSeq || snapshotNextSeq <= afterSeq) break;
    afterSeq = snapshotNextSeq;
  }

  return projector.result();
}

/** 逐块投影终端覆盖语义，避免为复制另外拼接一份无上限的原始日志。 */
class BoundedTerminalOutputProjector {
  private readonly completedParts: string[] = [];
  private completedBytes = 0;
  private currentLine = '';
  private currentLineBytes = 0;
  private currentLineExceeded = false;

  constructor(private readonly byteLimit: number) {}

  write(input: string): boolean {
    for (const segment of input.split(/([\r\n\b])/u)) {
      if (!segment) continue;
      if (segment === '\r') {
        this.currentLine = '';
        this.currentLineBytes = 0;
        this.currentLineExceeded = false;
        continue;
      }
      if (segment === '\n') {
        if (this.currentLineExceeded || this.completedBytes + this.currentLineBytes + 1 > this.byteLimit) return false;
        this.completedParts.push(this.currentLine, '\n');
        this.completedBytes += this.currentLineBytes + 1;
        this.currentLine = '';
        this.currentLineBytes = 0;
        continue;
      }
      if (segment === '\b') {
        if (this.currentLineExceeded || !this.currentLine) continue;
        this.currentLine = this.currentLine.slice(0, -1);
        this.currentLineBytes = Buffer.byteLength(this.currentLine, 'utf8');
        continue;
      }
      if (this.currentLineExceeded) continue;
      const nextBytes = Buffer.byteLength(segment, 'utf8');
      if (this.completedBytes + this.currentLineBytes + nextBytes > this.byteLimit) {
        this.currentLine = '';
        this.currentLineBytes = 0;
        this.currentLineExceeded = true;
        continue;
      }
      this.currentLine += segment;
      this.currentLineBytes += nextBytes;
    }
    return true;
  }

  result(): CommandRunOutputProjection {
    if (this.currentLineExceeded || this.completedBytes + this.currentLineBytes > this.byteLimit) return this.exceededResult();
    return {
      content: `${this.completedParts.join('')}${this.currentLine}`,
      byteLength: this.completedBytes + this.currentLineBytes,
      exceeded: false,
    };
  }

  exceededResult(): CommandRunOutputProjection {
    return { content: '', byteLength: 0, exceeded: true };
  }
}

function parseBoundedCommandRunInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function mimeTypeForPath(path: string): string | null {
  const extension = extname(path).toLocaleLowerCase();
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.html': 'text/html',
    '.pdf': 'application/pdf',
  };
  return mimeTypes[extension] ?? null;
}
