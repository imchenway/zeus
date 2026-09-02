import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  confirmGitOperation,
  createGitOperationConfirmation,
  executeHighRiskGitOperation,
  isGitConfirmationExpired,
  rejectGitOperation,
  type ExecuteHighRiskGitOperationInput,
  type ExecutedGitOperationResult,
  type GitOperationConfirmation,
  type HighRiskGitOperation,
} from '@zeus/git-core';
import type { AppendAuditLogInput, ProjectRepository, TaskRepository } from '@zeus/storage';
import { GitCommandApplication, gitCommandHttpError, gitCommandTypes, type GitCommandMutationRequest, type GitCommandType, type ParsedGitCommandMutation } from './gitCommandApplication.js';

interface CreateGitConfirmationInput {
  operation?: string;
  reason?: string;
  message?: string;
}

interface RejectGitConfirmationInput {
  reason?: string;
}

interface ExecuteGitOperationInput {
  confirmationId?: string;
  operation?: string;
  message?: string;
  branchName?: string;
  baseRef?: string;
  stashRef?: string;
  remote?: string;
  targetRef?: string;
}

type EmptyInput = Record<string, never>;
type GitExecutionPort = (input: ExecuteHighRiskGitOperationInput) => Promise<ExecutedGitOperationResult>;

interface GitConfirmationReplay<TResult> {
  commandType: string;
  inputSha256: string;
  result: TResult;
  expiresAtMs: number;
}

/**
 * Git 二次确认是短时安全能力，不是可恢复业务状态：不写 Command WAL，Core 重启即失效。
 * Command ID 只在有界内存中去重；同一确认在 write marker 前一次性消费。
 */
export class GitConfirmationCapabilityService {
  private readonly confirmations = new Map<string, GitOperationConfirmation>();
  private readonly consumedConfirmationIds = new Set<string>();
  private readonly recentCommands = new Map<string, GitConfirmationReplay<unknown>>();

  constructor(
    private readonly options: {
      now(): Date;
      maximumConfirmations?: number;
      maximumRecentCommands?: number;
      replayTtlMs?: number;
    },
  ) {}

  execute<TInput extends object, TResult>(parsed: ParsedGitCommandMutation<TInput>, mutation: () => TResult): { result: TResult; replayed: boolean } {
    this.prune();
    const replay = this.recentCommands.get(parsed.command.commandId);
    if (replay) {
      if (replay.commandType !== parsed.command.commandType || replay.inputSha256 !== parsed.inputSha256) {
        throw routeError('ZEUS_GIT_CONFIRMATION_COMMAND_CONFLICT', 'Git confirmation command identity was reused with different input', 409);
      }
      return { result: replay.result as TResult, replayed: true };
    }
    const result = mutation();
    this.recentCommands.set(parsed.command.commandId, {
      commandType: parsed.command.commandType,
      inputSha256: parsed.inputSha256,
      result,
      expiresAtMs: this.options.now().getTime() + (this.options.replayTtlMs ?? 10 * 60 * 1_000),
    });
    while (this.recentCommands.size > (this.options.maximumRecentCommands ?? 256)) {
      this.recentCommands.delete(this.recentCommands.keys().next().value as string);
    }
    return { result, replayed: false };
  }

  create(confirmation: GitOperationConfirmation): void {
    this.prune();
    if (this.confirmations.has(confirmation.id)) throw routeError('ZEUS_GIT_CONFIRMATION_ALREADY_EXISTS', 'Git confirmation already exists', 409);
    if (this.confirmations.size >= (this.options.maximumConfirmations ?? 128)) {
      throw routeError('ZEUS_GIT_CONFIRMATION_CAPACITY_EXCEEDED', 'Git confirmation capacity is exhausted; wait for an existing confirmation to expire', 429);
    }
    this.confirmations.set(confirmation.id, confirmation);
  }

  requirePending(confirmationId: string): GitOperationConfirmation {
    this.prune();
    const existing = this.confirmations.get(confirmationId);
    if (!existing) throw routeError('ZEUS_GIT_CONFIRMATION_NOT_FOUND', 'Git confirmation not found', 404);
    if (existing.status !== 'pending') throw routeError('ZEUS_GIT_CONFIRMATION_ALREADY_RESOLVED', 'Git confirmation is no longer pending', 409);
    return existing;
  }

  replace(confirmation: GitOperationConfirmation): void {
    if (!this.confirmations.has(confirmation.id)) throw routeError('ZEUS_GIT_CONFIRMATION_NOT_FOUND', 'Git confirmation not found', 404);
    this.confirmations.set(confirmation.id, confirmation);
  }

  consume(confirmationId: string, operation: HighRiskGitOperation): GitOperationConfirmation {
    this.prune();
    const confirmation = this.confirmations.get(confirmationId);
    if (!confirmation) throw routeError('ZEUS_GIT_CONFIRMATION_NOT_FOUND', 'Git confirmation not found', 404);
    if (this.consumedConfirmationIds.has(confirmation.id)) throw routeError('ZEUS_GIT_CONFIRMATION_ALREADY_CONSUMED', 'Git confirmation has already been consumed by an operation', 409);
    if (confirmation.status === 'rejected') throw routeError('ZEUS_GIT_CONFIRMATION_REJECTED', 'Git confirmation was rejected', 409);
    if (confirmation.status !== 'confirmed') throw routeError('ZEUS_GIT_CONFIRMATION_NOT_CONFIRMED', 'Git operation requires a confirmed confirmation', 409);
    if (confirmation.operation !== operation) throw routeError('ZEUS_GIT_OPERATION_MISMATCH', 'Git operation must match the confirmed operation', 400);
    this.consumedConfirmationIds.add(confirmation.id);
    return confirmation;
  }

  snapshot(): { confirmations: number; consumed: number; recentCommands: number } {
    this.prune();
    return { confirmations: this.confirmations.size, consumed: this.consumedConfirmationIds.size, recentCommands: this.recentCommands.size };
  }

  private prune(): void {
    const nowMs = this.options.now().getTime();
    for (const [commandId, replay] of this.recentCommands) if (replay.expiresAtMs <= nowMs) this.recentCommands.delete(commandId);
    for (const [confirmationId, confirmation] of this.confirmations) {
      if (Date.parse(confirmation.expiresAt) > nowMs) continue;
      this.confirmations.delete(confirmationId);
      this.consumedConfirmationIds.delete(confirmationId);
    }
  }
}

/** 只注册受确认保护的 Local Server Git mutation；Workbench、integration 与 Main IPC 不属于此模块。 */
export function registerGitCommandRoutes(options: {
  server: FastifyInstance;
  application: GitCommandApplication;
  projectRoot: string;
  projects: Pick<ProjectRepository, 'getById'>;
  tasks: Pick<TaskRepository, 'getById'>;
  executeOperation?: GitExecutionPort;
  redactSensitiveText(value: string): { text: string; redacted: boolean };
  appendAuditLog(input: Omit<AppendAuditLogInput, 'createdAt'> & { createdAt?: string }): void;
  publishRealtimeEvent(type: string, payload: Record<string, unknown>): unknown;
  save(): Promise<void>;
  now(): Date;
  confirmationTtlMs?: number;
  maximumConfirmations?: number;
  maximumConfirmationCommandReplays?: number;
}): void {
  const { server, application } = options;
  const confirmationCapabilities = new GitConfirmationCapabilityService({
    now: options.now,
    maximumConfirmations: options.maximumConfirmations,
    maximumRecentCommands: options.maximumConfirmationCommandReplays,
    replayTtlMs: options.confirmationTtlMs,
  });
  const executeOperation = options.executeOperation ?? executeHighRiskGitOperation;

  server.post('/api/git/confirmations', async (request: FastifyRequest<{ Body: GitCommandMutationRequest<CreateGitConfirmationInput> }>, reply) => {
    try {
      const parsed = application.parse<CreateGitConfirmationInput>({
        value: request.body,
        commandType: gitCommandTypes.confirmationCreate,
        scopeKind: 'approval',
        expectedScopeId: ({ operationIdentity }) => operationIdentity,
      });
      assertAllowedKeys(parsed.input, ['operation', 'reason', 'message'], parsed.command.commandType);
      const operation = requireHighRiskGitOperation(parsed.input.operation);
      const reason = requiredTrimmedString(parsed.input.reason, 'reason');
      const message = optionalTrimmedString(parsed.input.message, 'message');
      const mutation = confirmationCapabilities.execute(parsed, () => {
        const confirmation: GitOperationConfirmation = {
          ...createGitOperationConfirmation(
            {
              operation,
              cwd: options.projectRoot,
              reason: options.redactSensitiveText(reason).text,
              ...(message ? { message: options.redactSensitiveText(message).text } : {}),
            },
            { createdAt: options.now(), ttlMs: options.confirmationTtlMs ?? 10 * 60 * 1_000 },
          ),
          id: parsed.operationIdentity,
        };
        confirmationCapabilities.create(confirmation);
        return confirmation;
      });
      if (!mutation.replayed) {
        options.appendAuditLog({
          actorType: 'local_api',
          action: 'git.confirmation.created',
          resourceType: 'git_confirmation',
          resourceId: mutation.result.id,
          payload: {
            operation: mutation.result.operation,
            cwd: mutation.result.cwd,
            reason: mutation.result.reason,
            message: mutation.result.message ?? null,
            riskLevel: mutation.result.riskLevel,
          },
          createdAt: mutation.result.createdAt,
        });
        await options.save();
        options.publishRealtimeEvent('git.confirmation.created', {
          confirmationId: mutation.result.id,
          operation: mutation.result.operation,
          riskLevel: mutation.result.riskLevel,
        });
      }
      return reply.code(mutation.replayed ? 200 : 201).send(mutation.result);
    } catch (error) {
      return sendGitCommandError(reply, error, 'ZEUS_GIT_COMMAND_REJECTED', 'Git command rejected', options.redactSensitiveText);
    }
  });

  server.post('/api/git/confirmations/:confirmationId/reject', async (request: FastifyRequest<{ Params: { confirmationId: string }; Body: GitCommandMutationRequest<RejectGitConfirmationInput> }>, reply) => {
    try {
      const confirmationId = requiredIdentity(request.params.confirmationId, 'confirmationId');
      const parsed = application.parse<RejectGitConfirmationInput>({
        value: request.body,
        commandType: gitCommandTypes.confirmationReject,
        scopeKind: 'approval',
        expectedScopeId: () => confirmationId,
      });
      assertAllowedKeys(parsed.input, ['reason'], parsed.command.commandType);
      const rawReason = optionalTrimmedString(parsed.input.reason, 'reason');
      const mutation = confirmationCapabilities.execute(parsed, () => {
        const existing = confirmationCapabilities.requirePending(confirmationId);
        const rejected = rejectGitOperation(existing, options.now(), rawReason ? options.redactSensitiveText(rawReason).text : undefined);
        confirmationCapabilities.replace(rejected);
        return rejected;
      });
      if (!mutation.replayed) {
        options.appendAuditLog({
          actorType: 'local_api',
          action: 'security.confirmation.rejected',
          resourceType: 'git_confirmation',
          resourceId: mutation.result.id,
          payload: {
            operation: mutation.result.operation,
            cwd: mutation.result.cwd,
            riskLevel: mutation.result.riskLevel,
            rejectedAt: mutation.result.rejectedAt,
            rejectedReason: mutation.result.rejectedReason ?? null,
          },
          createdAt: mutation.result.rejectedAt ?? options.now().toISOString(),
        });
        await options.save();
        options.publishRealtimeEvent('security.confirmation.rejected', {
          confirmationId: mutation.result.id,
          operation: mutation.result.operation,
          riskLevel: mutation.result.riskLevel,
        });
      }
      return mutation.result;
    } catch (error) {
      return sendGitCommandError(reply, error, 'ZEUS_GIT_COMMAND_REJECTED', 'Git command rejected', options.redactSensitiveText);
    }
  });

  server.post('/api/git/confirmations/:confirmationId/confirm', async (request: FastifyRequest<{ Params: { confirmationId: string }; Body: GitCommandMutationRequest<EmptyInput> }>, reply) => {
    try {
      const confirmationId = requiredIdentity(request.params.confirmationId, 'confirmationId');
      const parsed = application.parse<EmptyInput>({
        value: request.body,
        commandType: gitCommandTypes.confirmationConfirm,
        scopeKind: 'approval',
        expectedScopeId: () => confirmationId,
      });
      assertAllowedKeys(parsed.input, [], parsed.command.commandType);
      const mutation = confirmationCapabilities.execute(parsed, () => {
        const existing = confirmationCapabilities.requirePending(confirmationId);
        if (isGitConfirmationExpired(existing, options.now())) throw routeError('ZEUS_GIT_CONFIRMATION_EXPIRED', 'Git confirmation has expired', 409);
        const confirmed = confirmGitOperation(existing, options.now());
        confirmationCapabilities.replace(confirmed);
        return confirmed;
      });
      if (!mutation.replayed) {
        const createdAt = mutation.result.confirmedAt ?? options.now().toISOString();
        options.appendAuditLog({
          actorType: 'local_api',
          action: 'git.confirmation.confirmed',
          resourceType: 'git_confirmation',
          resourceId: mutation.result.id,
          payload: { operation: mutation.result.operation, cwd: mutation.result.cwd, riskLevel: mutation.result.riskLevel, confirmedAt: mutation.result.confirmedAt },
          createdAt,
        });
        options.appendAuditLog({
          actorType: 'local_api',
          action: 'security.confirmation.approved',
          resourceType: 'git_confirmation',
          resourceId: mutation.result.id,
          payload: { operation: mutation.result.operation, cwd: mutation.result.cwd, riskLevel: mutation.result.riskLevel, confirmedAt: mutation.result.confirmedAt },
          createdAt,
        });
        await options.save();
        options.publishRealtimeEvent('security.confirmation.approved', {
          confirmationId: mutation.result.id,
          operation: mutation.result.operation,
          riskLevel: mutation.result.riskLevel,
        });
      }
      return mutation.result;
    } catch (error) {
      return sendGitCommandError(reply, error, 'ZEUS_GIT_COMMAND_REJECTED', 'Git command rejected', options.redactSensitiveText);
    }
  });

  server.post('/api/git/operations', async (request: FastifyRequest<{ Body: GitCommandMutationRequest<ExecuteGitOperationInput> }>, reply) => {
    try {
      const parsed = application.parse<ExecuteGitOperationInput>({
        value: request.body,
        commandType: gitCommandTypes.operationExecute,
        scopeKind: 'git_repository',
        expectedScopeId: () => 'primary',
      });
      return await executeConfirmedOperation({ options, application, parsed, confirmationCapabilities, executeOperation });
    } catch (error) {
      return sendGitCommandError(reply, error, 'ZEUS_GIT_OPERATION_REJECTED', 'Git operation rejected', options.redactSensitiveText);
    }
  });

  registerProjectOperation({ options, application, confirmationCapabilities, executeOperation, path: '/api/projects/:projectId/git/branch', commandType: gitCommandTypes.projectBranch, operation: 'branch' });
  registerProjectOperation({ options, application, confirmationCapabilities, executeOperation, path: '/api/projects/:projectId/git/checkout', commandType: gitCommandTypes.projectCheckout, operation: 'switch_branch' });
  registerProjectOperation({ options, application, confirmationCapabilities, executeOperation, path: '/api/projects/:projectId/git/commit', commandType: gitCommandTypes.projectCommit, operation: 'commit' });
  registerProjectOperation({ options, application, confirmationCapabilities, executeOperation, path: '/api/projects/:projectId/git/stash', commandType: gitCommandTypes.projectStash, operation: 'stash' });
  registerProjectOperation({ options, application, confirmationCapabilities, executeOperation, path: '/api/projects/:projectId/git/apply-stash', commandType: gitCommandTypes.projectApplyStash, operation: 'apply_stash' });
  registerProjectOperation({ options, application, confirmationCapabilities, executeOperation, path: '/api/projects/:projectId/git/pull', commandType: gitCommandTypes.projectPull, operation: 'pull' });
  registerProjectOperation({ options, application, confirmationCapabilities, executeOperation, path: '/api/projects/:projectId/git/push', commandType: gitCommandTypes.projectPush, operation: 'push' });

  server.post('/api/tasks/:taskId/git/rollback', async (request: FastifyRequest<{ Params: { taskId: string }; Body: GitCommandMutationRequest<ExecuteGitOperationInput> }>, reply) => {
    try {
      const taskId = requiredIdentity(request.params.taskId, 'taskId');
      if (!options.tasks.getById(taskId)) throw routeError('ZEUS_TASK_NOT_FOUND', 'Task not found', 404);
      const parsed = application.parse<ExecuteGitOperationInput>({
        value: request.body,
        commandType: gitCommandTypes.taskRollback,
        scopeKind: 'git_repository',
        expectedScopeId: () => `task:${taskId}`,
      });
      return await executeConfirmedOperation({ options, application, parsed, confirmationCapabilities, executeOperation, fixedOperation: 'rollback' });
    } catch (error) {
      return sendGitCommandError(reply, error, 'ZEUS_GIT_OPERATION_REJECTED', 'Git rollback rejected', options.redactSensitiveText);
    }
  });
}

function registerProjectOperation(input: {
  options: Parameters<typeof registerGitCommandRoutes>[0];
  application: GitCommandApplication;
  confirmationCapabilities: GitConfirmationCapabilityService;
  executeOperation: GitExecutionPort;
  path: `/api/projects/:projectId/git/${string}`;
  commandType: GitCommandType;
  operation: HighRiskGitOperation;
}): void {
  input.options.server.post(input.path, async (request: FastifyRequest<{ Params: { projectId: string }; Body: GitCommandMutationRequest<ExecuteGitOperationInput> }>, reply) => {
    try {
      const projectId = requiredIdentity(request.params.projectId, 'projectId');
      if (!input.options.projects.getById(projectId)) throw routeError('ZEUS_PROJECT_NOT_FOUND', 'Project not found', 404);
      const parsed = input.application.parse<ExecuteGitOperationInput>({
        value: request.body,
        commandType: input.commandType,
        scopeKind: 'git_repository',
        expectedScopeId: () => `project:${projectId}`,
      });
      return await executeConfirmedOperation({ ...input, parsed, fixedOperation: input.operation });
    } catch (error) {
      return sendGitCommandError(reply, error, 'ZEUS_GIT_OPERATION_REJECTED', 'Git project operation rejected', input.options.redactSensitiveText);
    }
  });
}

async function executeConfirmedOperation(input: {
  options: Parameters<typeof registerGitCommandRoutes>[0];
  application: GitCommandApplication;
  parsed: ParsedGitCommandMutation<ExecuteGitOperationInput>;
  confirmationCapabilities: GitConfirmationCapabilityService;
  executeOperation: GitExecutionPort;
  fixedOperation?: HighRiskGitOperation;
}): Promise<ExecutedGitOperationResult> {
  assertAllowedKeys(input.parsed.input, ['confirmationId', 'operation', 'message', 'branchName', 'baseRef', 'stashRef', 'remote', 'targetRef'], input.parsed.command.commandType);
  const confirmationId = requiredIdentity(input.parsed.input.confirmationId, 'confirmationId');
  const requestedOperation = input.fixedOperation ?? requireHighRiskGitOperation(input.parsed.input.operation);
  if (input.fixedOperation && input.parsed.input.operation !== undefined && input.parsed.input.operation !== input.fixedOperation) {
    throw routeError('ZEUS_GIT_OPERATION_MISMATCH', 'Git operation must match the addressed route', 400);
  }
  let prepared: ExecuteHighRiskGitOperationInput | undefined;
  const mutation = await input.application.executeExternal({
    parsed: input.parsed,
    destinationId: 'git-core:high-risk-operation',
    resourceId: input.parsed.command.scope.id,
    // Confirmation 是真实的一次性授权身份；更换 command 也不能让同一确认被第二次消费。
    externalOperationId: `git-confirmation:${confirmationId}`,
    beforeWrite: async () => {
      // 安全能力必须先核对并一次性消费，再允许 Application 写 durable write marker。
      const confirmation = input.confirmationCapabilities.consume(confirmationId, requestedOperation);
      prepared = {
        confirmation,
        operation: requestedOperation,
        message: input.parsed.input.message,
        branchName: input.parsed.input.branchName,
        baseRef: input.parsed.input.baseRef,
        stashRef: input.parsed.input.stashRef,
        remote: input.parsed.input.remote,
        targetRef: input.parsed.input.targetRef,
      };
      // 使用空 runner 只构造并校验白名单参数；此时尚未写 write marker，也绝不启动 Git。
      try {
        await executeHighRiskGitOperation({ ...prepared, runner: async () => ({ stdout: '', stderr: '' }) });
      } catch (error) {
        throw routeError('ZEUS_GIT_OPERATION_INVALID', error instanceof Error ? error.message : 'Git operation parameters are invalid', 400);
      }
    },
    invoke: async () => {
      if (!prepared) throw routeError('ZEUS_GIT_OPERATION_REJECTED', 'Git operation preflight did not complete', 409);
      return input.executeOperation(prepared);
    },
    mutateAcceptedBusinessState: (result) => {
      input.options.appendAuditLog({
        actorType: 'local_api',
        action: 'git.operation.executed',
        resourceType: 'git_confirmation',
        resourceId: confirmationId,
        payload: { operation: result.operation, cwd: result.cwd, args: result.args, stdoutLength: result.stdout.length, stderrLength: result.stderr.length },
        createdAt: input.options.now().toISOString(),
      });
    },
  });
  return mutation.result;
}

function requireHighRiskGitOperation(value: unknown): HighRiskGitOperation {
  if (value === 'commit' || value === 'stash' || value === 'apply_stash' || value === 'rollback' || value === 'branch' || value === 'switch_branch' || value === 'pull' || value === 'push') return value;
  throw routeError('ZEUS_INVALID_GIT_OPERATION', 'Git operation must be commit, stash, apply_stash, rollback, branch, switch_branch, pull or push', 400);
}

function requiredIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 512) throw routeError('ZEUS_INVALID_GIT_OPERATION', `${field} is invalid`, 400);
  return value;
}

function requiredTrimmedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw routeError('ZEUS_INVALID_GIT_CONFIRMATION', `${field} is required`, 400);
  return value.trim();
}

function optionalTrimmedString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw routeError('ZEUS_INVALID_GIT_CONFIRMATION', `${field} must be a string`, 400);
  return value.trim() || undefined;
}

function assertAllowedKeys(value: object, allowed: readonly string[], commandType: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw routeError('ZEUS_GIT_COMMAND_INVALID', `${commandType} contains unsupported fields: ${extra.join(', ')}`, 400);
}

class GitCommandRouteError extends Error {
  readonly name = 'GitCommandRouteError';

  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function routeError(code: string, message: string, statusCode: number): GitCommandRouteError {
  return new GitCommandRouteError(code, message, statusCode);
}

function sendGitCommandError(reply: FastifyReply, error: unknown, fallbackCode: string, fallbackMessage: string, redactSensitiveText: (value: string) => { text: string }): unknown {
  const commandError = gitCommandHttpError(error);
  if (commandError) return reply.code(commandError.statusCode).send({ ...commandError.payload, message: boundedPublicErrorMessage(commandError.payload.message, redactSensitiveText) });
  if (error instanceof GitCommandRouteError) return reply.code(error.statusCode).send({ error: error.code, message: boundedPublicErrorMessage(error.message, redactSensitiveText) });
  return reply.code(500).send({ error: fallbackCode, message: boundedPublicErrorMessage(error instanceof Error ? error.message : fallbackMessage, redactSensitiveText) });
}

function boundedPublicErrorMessage(value: string, redactSensitiveText: (value: string) => { text: string }): string {
  const redacted = redactSensitiveText(value).text;
  const bytes = Buffer.from(redacted, 'utf8');
  if (bytes.byteLength <= 2 * 1024) return redacted;
  return `${bytes
    .subarray(0, 2 * 1024 - 3)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')}...`;
}
