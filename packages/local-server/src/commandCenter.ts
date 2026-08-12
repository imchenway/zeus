import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
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
  CommandDefinitionRepository,
  CommandRunRepository,
  type AppendAuditLogInput,
  type ProjectRepository,
  type RuntimeSessionRepository,
  type ZeusDatabase,
  type ZeusRuntimeLogRecord,
  type ZeusRuntimeSessionRecord,
} from '@zeus/storage';

const MAX_COMMAND_RUN_LOG_PAYLOAD_BYTES = 4 * 1024 * 1024;

interface CommandCenterOptions {
  server: FastifyInstance;
  db: ZeusDatabase;
  projects: ProjectRepository;
  runtimeSessions: RuntimeSessionRepository;
  aiRuntimeManager: AiRuntimeSessionManager;
  commandScriptsDirectory: string;
  commandRunsDirectory: string;
  readProjectSecurity: (projectId: string) => { allowShell: boolean; allowGitWrite: boolean };
  buildRuntimeProcessEnv: () => NodeJS.ProcessEnv;
  createReleaseNotesCapability?: (input: { runId: string; projectId: string }) => { url: string; token: string };
  revokeReleaseNotesCapability?: (runId: string) => void;
  appendAuditLog: (input: Omit<AppendAuditLogInput, 'createdAt'> & { createdAt?: string }) => void;
  publishRealtimeEvent: (type: string, payload: Record<string, unknown>) => unknown;
  save: () => Promise<void>;
  now?: () => Date;
  confirmationTtlMs?: number;
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
  confirmationId?: string;
  parameters?: Record<string, unknown>;
}

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
  const artifacts = new CommandArtifactRepository(options.db);
  const confirmations = new Map<string, StoredCommandConfirmation>();
  const timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();
  const forceKillHandles = new Map<string, ReturnType<typeof setTimeout>>();
  const artifactBuffers = new Map<string, string>();
  const now = options.now ?? (() => new Date());
  const confirmationTtlMs = options.confirmationTtlMs ?? 10 * 60 * 1000;

  mkdirSync(options.commandScriptsDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(options.commandRunsDirectory, { recursive: true, mode: 0o700 });
  recoverInterruptedRuns();

  options.server.get('/api/commands/global', async () => definitions.listGlobal());

  options.server.post('/api/commands/global', async (request: FastifyRequest<{ Body: CommandDefinitionInput }>, reply) => createDefinition('global', null, request.body, reply));

  options.server.patch('/api/commands/global/:commandId', async (request: FastifyRequest<{ Params: { commandId: string }; Body: Partial<CommandDefinitionInput> }>, reply) =>
    updateDefinition('global', null, request.params.commandId, request.body, reply),
  );

  options.server.delete('/api/commands/global/:commandId', async (request: FastifyRequest<{ Params: { commandId: string } }>, reply) => deleteDefinition('global', null, request.params.commandId, reply));

  options.server.get('/api/projects/:projectId/commands', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    if (!requireProject(request.params.projectId, reply)) return;
    return definitions.listMerged(request.params.projectId);
  });

  options.server.post('/api/projects/:projectId/commands', async (request: FastifyRequest<{ Params: { projectId: string }; Body: CommandDefinitionInput }>, reply) => {
    if (!requireProject(request.params.projectId, reply)) return;
    return createDefinition('project', request.params.projectId, request.body, reply);
  });

  options.server.patch('/api/projects/:projectId/commands/:commandId', async (request: FastifyRequest<{ Params: { projectId: string; commandId: string }; Body: Partial<CommandDefinitionInput> }>, reply) => {
    if (!requireProject(request.params.projectId, reply)) return;
    return updateDefinition('project', request.params.projectId, request.params.commandId, request.body, reply);
  });

  options.server.delete('/api/projects/:projectId/commands/:commandId', async (request: FastifyRequest<{ Params: { projectId: string; commandId: string } }>, reply) => {
    if (!requireProject(request.params.projectId, reply)) return;
    return deleteDefinition('project', request.params.projectId, request.params.commandId, reply);
  });

  options.server.post('/api/projects/:projectId/commands/:commandId/confirmations', async (request: FastifyRequest<{ Params: { projectId: string; commandId: string }; Body: CommandConfirmationBody }>, reply) =>
    createConfirmation(request.params.projectId, request.params.commandId, request.body, reply),
  );

  options.server.post('/api/projects/:projectId/commands/:commandId/runs', async (request: FastifyRequest<{ Params: { projectId: string; commandId: string }; Body: CommandRunBody }>, reply) =>
    startRun(request.params.projectId, request.params.commandId, request.body, reply),
  );

  options.server.get('/api/projects/:projectId/command-runs', async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: { limit?: string } }>, reply) => {
    if (!requireProject(request.params.projectId, reply)) return;
    expireConfirmations();
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

  options.server.post('/api/command-runs/:runId/stop', async (request: FastifyRequest<{ Params: { runId: string } }>, reply) => {
    const run = runs.getById(request.params.runId);
    if (!run) return notFound(reply, 'ZEUS_COMMAND_RUN_NOT_FOUND', 'Command run not found');
    if (run.status !== 'running' || !run.runtimeSessionId) {
      return reply.code(409).send({ error: 'ZEUS_COMMAND_RUN_NOT_RUNNING', message: 'Command run is not running' });
    }
    clearRunTimeout(run.id);
    options.revokeReleaseNotesCapability?.(run.id);
    const endedAt = now().toISOString();
    const updated = runs.update(run.id, { status: 'cancelled', endedAt, failureReason: '用户停止执行' });
    options.aiRuntimeManager.stopSession(run.runtimeSessionId);
    scheduleForceKill(run.id, run.runtimeSessionId);
    appendRunAudit('command.run.cancelled', updated);
    publishRun('command.run.cancelled', updated);
    await options.save();
    return updated;
  });

  options.server.get('/api/command-artifacts/:artifactId/content', async (request: FastifyRequest<{ Params: { artifactId: string } }>, reply) => {
    const artifact = findArtifactById(request.params.artifactId);
    if (!artifact) return notFound(reply, 'ZEUS_COMMAND_ARTIFACT_NOT_FOUND', 'Command artifact not found');
    const run = runs.getById(artifact.runId);
    if (!run) return notFound(reply, 'ZEUS_COMMAND_RUN_NOT_FOUND', 'Command run not found');
    const runDirectory = commandRunDirectory(run.id);
    const verified = verifyArtifactPath(artifact.absolutePath, runDirectory);
    if (!verified) return reply.code(410).send({ error: 'ZEUS_COMMAND_ARTIFACT_UNAVAILABLE', message: 'Command artifact is no longer available' });
    reply.type(artifact.mimeType ?? 'application/octet-stream');
    return reply.send(readFileSync(verified));
  });

  async function createDefinition(scope: CommandScope, projectId: string | null, rawInput: CommandDefinitionInput, reply: FastifyReply): Promise<CommandDefinition | unknown> {
    const input = normalizeDefinitionInput(rawInput);
    if (!input) return invalidDefinition(reply, [{ field: 'body', message: '命令定义格式无效。' }]);
    const issues = validateCommandDefinitionInput(input);
    if (scope === 'global' && projectId !== null) issues.push({ field: 'projectId', message: '全局命令不能绑定项目。' });
    const conflicts = definitions.findTokenConflicts({
      scope,
      projectId,
      tokens: [input.name, ...(input.aliases ?? [])],
    });
    if (conflicts.length > 0) {
      return reply.code(409).send({
        error: 'ZEUS_COMMAND_TOKEN_CONFLICT',
        message: `名称或别名与 ${conflicts[0]!.commandName} 冲突。`,
        conflicts,
      });
    }
    if (issues.length > 0) return invalidDefinition(reply, issues);
    const created = definitions.create({ ...input, scope, projectId });
    options.appendAuditLog({
      actorType: 'local_api',
      action: 'command.definition.created',
      resourceType: 'command_definition',
      resourceId: created.id,
      payload: definitionAuditPayload(created),
    });
    options.publishRealtimeEvent('command.definition.created', definitionEventPayload(created));
    await options.save();
    return reply.code(201).send(created);
  }

  async function updateDefinition(expectedScope: CommandScope, expectedProjectId: string | null, commandId: string, patch: Partial<CommandDefinitionInput>, reply: FastifyReply): Promise<CommandDefinition | unknown> {
    const existing = definitions.getById(commandId);
    if (!existing || existing.scope !== expectedScope || existing.projectId !== expectedProjectId) {
      return notFound(reply, 'ZEUS_COMMAND_NOT_FOUND', 'Command definition not found');
    }
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
    const updated = definitions.update(existing.id, { ...input, revision: existing.revision + 1 });
    invalidateCommandConfirmations(existing.id, '命令定义已变化');
    options.appendAuditLog({
      actorType: 'local_api',
      action: 'command.definition.updated',
      resourceType: 'command_definition',
      resourceId: updated.id,
      payload: definitionAuditPayload(updated),
    });
    options.publishRealtimeEvent('command.definition.updated', definitionEventPayload(updated));
    await options.save();
    return updated;
  }

  async function deleteDefinition(expectedScope: CommandScope, expectedProjectId: string | null, commandId: string, reply: FastifyReply): Promise<CommandDefinition | unknown> {
    const existing = definitions.getById(commandId);
    if (!existing || existing.scope !== expectedScope || existing.projectId !== expectedProjectId) {
      return notFound(reply, 'ZEUS_COMMAND_NOT_FOUND', 'Command definition not found');
    }
    definitions.delete(existing.id);
    invalidateCommandConfirmations(existing.id, '命令定义已删除');
    options.appendAuditLog({
      actorType: 'local_api',
      action: 'command.definition.deleted',
      resourceType: 'command_definition',
      resourceId: existing.id,
      payload: definitionAuditPayload(existing),
    });
    options.publishRealtimeEvent('command.definition.deleted', definitionEventPayload(existing));
    await options.save();
    return existing;
  }

  async function createConfirmation(projectId: string, commandId: string, body: CommandConfirmationBody | undefined, reply: FastifyReply): Promise<CommandConfirmation | unknown> {
    expireConfirmations();
    const project = requireProject(projectId, reply);
    if (!project) return;
    const command = definitions.getById(commandId);
    if (!command || (command.scope === 'project' && command.projectId !== projectId)) {
      return notFound(reply, 'ZEUS_COMMAND_NOT_FOUND', 'Command definition not found');
    }
    if (!command.enabled) return reply.code(409).send({ error: 'ZEUS_COMMAND_DISABLED', message: 'Command is disabled' });
    const permissionError = commandPermissionError(projectId, command);
    if (permissionError) return reply.code(403).send(permissionError);
    const parameters = normalizeRunParameters(command.parameters, body?.parameters ?? {});
    if ('issues' in parameters) return reply.code(400).send({ error: 'ZEUS_INVALID_COMMAND_PARAMETERS', message: 'Command parameters are invalid', issues: parameters.issues });
    const riskLevel = commandNeedsHighRiskConfirmation(command.riskFlags) ? 'high' : 'normal';
    const trigger = body?.trigger === 'telegram' ? 'telegram' : 'desktop';
    const parameterSnapshot = nonSensitiveParameterSnapshot(command.parameters, parameters.values);
    const run = runs.create({
      commandId: command.id,
      projectId,
      trigger,
      status: 'pending_confirmation',
      commandSnapshot: command,
      parameterSnapshot,
      cwd: project.localPath,
      timeoutSeconds: command.timeoutSeconds,
    });
    const createdAt = now();
    const confirmation: StoredCommandConfirmation = {
      id: randomUUID(),
      runId: run.id,
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
    confirmations.set(confirmation.id, confirmation);
    options.appendAuditLog({
      actorType: trigger,
      action: 'command.confirmation.created',
      resourceType: 'command_confirmation',
      resourceId: confirmation.id,
      payload: {
        runId: run.id,
        commandId: command.id,
        commandRevision: command.revision,
        projectId,
        cwd: project.localPath,
        parameterKeys: Object.keys(parameters.values),
        riskLevel,
        expiresAt: confirmation.expiresAt,
      },
    });
    options.publishRealtimeEvent('command.confirmation.created', {
      confirmationId: confirmation.id,
      runId: run.id,
      commandId: command.id,
      projectId,
      riskLevel,
    });
    await options.save();
    return reply.code(201).send(toPublicConfirmation(confirmation));
  }

  async function startRun(projectId: string, commandId: string, body: CommandRunBody | undefined, reply: FastifyReply): Promise<CommandRun | unknown> {
    expireConfirmations();
    const project = requireProject(projectId, reply);
    if (!project) return;
    const command = definitions.getById(commandId);
    if (!command || (command.scope === 'project' && command.projectId !== projectId)) {
      return notFound(reply, 'ZEUS_COMMAND_NOT_FOUND', 'Command definition not found');
    }
    const confirmation = body?.confirmationId ? confirmations.get(body.confirmationId) : undefined;
    if (!confirmation) {
      return reply.code(400).send({ error: 'ZEUS_COMMAND_CONFIRMATION_REQUIRED', message: 'A valid command confirmation is required' });
    }
    const parameters = normalizeRunParameters(command.parameters, body?.parameters ?? {});
    if ('issues' in parameters) {
      rejectConfirmation(confirmation, '命令参数已变化');
      await options.save();
      return reply.code(400).send({ error: 'ZEUS_INVALID_COMMAND_PARAMETERS', message: 'Command parameters are invalid', issues: parameters.issues });
    }
    const unchanged =
      command.enabled &&
      confirmation.commandId === command.id &&
      confirmation.projectId === projectId &&
      confirmation.commandRevision === command.revision &&
      confirmation.cwd === project.localPath &&
      confirmation.parameterDigest === digestParameters(parameters.values);
    if (!unchanged) {
      rejectConfirmation(confirmation, '命令、项目、目录或参数在确认后发生变化');
      await options.save();
      return reply.code(409).send({ error: 'ZEUS_COMMAND_CONFIRMATION_STALE', message: 'Command confirmation is no longer valid' });
    }
    const permissionError = commandPermissionError(projectId, command);
    if (permissionError) {
      rejectConfirmation(confirmation, permissionError.message);
      await options.save();
      return reply.code(403).send(permissionError);
    }
    confirmations.delete(confirmation.id);
    const runDirectory = commandRunDirectory(confirmation.runId);
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const releaseNotesCapability = isReleaseCommand(command.command) ? options.createReleaseNotesCapability?.({ runId: confirmation.runId, projectId }) : undefined;
    const environment = {
      ...options.buildRuntimeProcessEnv(),
      ...parameterEnvironment(command.parameters, parameters.values),
      ZEUS_PROJECT_ROOT: project.localPath,
      ZEUS_COMMAND_SCRIPTS_DIR: options.commandScriptsDirectory,
      ZEUS_COMMAND_RUN_DIR: runDirectory,
      ZEUS_COMMAND_ID: command.id,
      ZEUS_COMMAND_RUN_ID: confirmation.runId,
      ...(releaseNotesCapability
        ? {
            ZEUS_RELEASE_NOTES_API_URL: releaseNotesCapability.url,
            ZEUS_RELEASE_NOTES_CAPABILITY: releaseNotesCapability.token,
          }
        : {}),
    };
    try {
      const session = await options.aiRuntimeManager.startSession({
        projectId,
        command: 'sh',
        args: ['-lc', command.command],
        cwd: project.localPath,
        env: environment,
        redactValues: [...confirmation.sensitiveValues, ...(releaseNotesCapability ? [releaseNotesCapability.token] : [])],
      });
      const startedAt = now().toISOString();
      const updated = runs.update(confirmation.runId, {
        status: 'running',
        runtimeSessionId: session.id,
        startedAt,
      });
      appendRunAudit('command.run.started', updated);
      publishRun('command.run.started', updated);
      scheduleRunTimeout(updated);
      handleRuntimeSessionChange(session);
      await options.save();
      return reply.code(201).send(updated);
    } catch (error) {
      options.revokeReleaseNotesCapability?.(confirmation.runId);
      const failed = runs.update(confirmation.runId, {
        status: 'failed',
        failureReason: error instanceof Error ? error.message : String(error),
        endedAt: now().toISOString(),
      });
      appendRunAudit('command.run.failed', failed);
      publishRun('command.run.failed', failed);
      await options.save();
      return reply.code(400).send({ error: 'ZEUS_COMMAND_RUN_REJECTED', message: failed.failureReason, run: failed });
    }
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
    const file = statSync(verified);
    const relativePath = relative(realpathSync(runDirectory), verified).replace(/\\/gu, '/');
    const artifact = artifacts.create({
      runId: run.id,
      relativePath,
      absolutePath: verified,
      mimeType: mimeTypeForPath(verified),
      byteLength: file.size,
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

  function expireConfirmations(): void {
    const currentTime = now().getTime();
    for (const confirmation of confirmations.values()) {
      if (Date.parse(confirmation.expiresAt) <= currentTime) rejectConfirmation(confirmation, '命令确认已过期');
    }
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

  function appendRunAudit(action: string, run: CommandRun): void {
    options.appendAuditLog({
      actorType: run.trigger,
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
    for (const run of runs.listActive()) {
      const artifact = artifacts.listByRun(run.id).find((candidate) => candidate.id === artifactId);
      if (artifact) return artifact;
    }
    const row = options.db.get<{
      id: string;
      run_id: string;
      relative_path: string;
      absolute_path: string;
      mime_type: string | null;
      byte_length: number;
      created_at: string;
    }>(`SELECT id, run_id, relative_path, absolute_path, mime_type, byte_length, created_at FROM command_artifacts WHERE id = ?`, [artifactId]);
    return row
      ? {
          id: row.id,
          runId: row.run_id,
          relativePath: row.relative_path,
          absolutePath: row.absolute_path,
          mimeType: row.mime_type,
          byteLength: row.byte_length,
          createdAt: row.created_at,
        }
      : undefined;
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
    for (const [runId, timeout] of forceKillHandles) {
      clearTimeout(timeout);
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
    timeoutHandles.clear();
    forceKillHandles.clear();
    confirmations.clear();
    artifactBuffers.clear();
  }

  return { handleRuntimeSessionChange, handleRuntimeLog, stopActiveRuns, close };
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
