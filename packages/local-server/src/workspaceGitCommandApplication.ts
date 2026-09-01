import { createHash } from 'node:crypto';
import { canonicalCommandInputJson, CommandEnvelopeError, parseCommandEnvelope, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { ArtifactStore, CommandDeliveryRepository, CommandDeliveryStoreError, type ArtifactRef, type CommandDeliveryOutcome, type CommandDeliveryReceiptRecord, type CommandOutboxRecord, type ZeusDatabase } from '@zeus/storage';
import { createCommandValidation } from './commandApplicationPrimitives.js';

export const workspaceGitCommandTypes = {
  workbenchAction: 'git.workbench.repository.action',
  taskWorkspaceCommitAll: 'git.task_workspace.commit_all',
  taskWorkspacePushAll: 'git.task_workspace.push_all',
  taskWorkspaceCommit: 'git.task_workspace.commit',
  taskWorkspacePush: 'git.task_workspace.push',
  taskWorkspaceStopSessions: 'git.task_workspace.stop_sessions',
  taskWorkspaceReclaim: 'git.task_workspace.reclaim',
  taskWorkspaceDiscard: 'git.task_workspace.discard',
  taskWorkspaceIntegrate: 'git.task_workspace.integrate',
  taskIntegrationConflictAiSession: 'git.task_integration.conflict_ai_session',
  taskIntegrationConflictResolve: 'git.task_integration.conflict_resolve',
  taskIntegrationFinalize: 'git.task_integration.finalize',
  taskIntegrationPush: 'git.task_integration.push',
  projectSnapshotCreate: 'git.project.snapshot.create',
  projectPatchExport: 'git.project.patch.export',
  taskPushRepositoryRefreshRemote: 'git.task_push.repository.refresh_remote',
} as const;

export type WorkspaceGitCommandType = (typeof workspaceGitCommandTypes)[keyof typeof workspaceGitCommandTypes];
export type WorkspaceGitScopeKind = Extract<CommandScopeKind, 'project' | 'task' | 'task_workspace' | 'task_integration' | 'git_repository'>;

export interface WorkspaceGitCommandPayload extends Record<string, unknown> {
  operationIdentity: string;
  inputSha256: string;
}

export interface WorkspaceGitMutationRequest<TInput extends object> {
  command: CommandEnvelope<WorkspaceGitCommandPayload>;
  input: TInput;
}

export interface ParsedWorkspaceGitMutation<TInput extends object> {
  command: CommandEnvelope<WorkspaceGitCommandPayload>;
  input: TInput;
  inputSha256: string;
  operationIdentity: string;
}

export interface WorkspaceGitMutationResult<TResult> {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  result: TResult;
}

interface ExternalPreparation {
  state: 'prepared' | 'accepted_replay';
  parsed: ParsedWorkspaceGitMutation<object>;
  outbox: CommandOutboxRecord;
  receipt?: CommandDeliveryReceiptRecord;
}

export class WorkspaceGitCommandApplicationError extends Error {
  readonly name = 'WorkspaceGitCommandApplicationError';

  constructor(
    readonly code: 'ZEUS_WORKSPACE_GIT_COMMAND_INVALID' | 'ZEUS_WORKSPACE_GIT_COMMAND_RESULT_MISSING' | 'ZEUS_WORKSPACE_GIT_COMMAND_RESULT_TOO_LARGE' | 'ZEUS_WORKSPACE_GIT_COMMAND_OUTCOME_UNKNOWN',
    message: string,
    readonly statusCode: 400 | 409 | 500,
    readonly recoveryRequired = false,
  ) {
    super(message);
  }
}

const resultArtifactGeneration = 'workspace-git-command-result-v1';
const maximumReplayResultBytes = 32 * 1024 * 1024;
const maximumErrorMessageBytes = 2 * 1024;
const { requireRecord, assertExactKeys, boundedIdentity, validSha256 } = createCommandValidation(invalidCommand);

/**
 * Project Workbench、Task Workspace 与 Integration 的公开 External Command 边界。
 * Git、文件、进程或 Provider 写出前必须先落 marker；accepted 只保存 ArtifactRef，unknown 禁止自动重发。
 */
export class WorkspaceGitCommandApplication {
  private readonly activeExternalExecutions = new Map<string, Promise<WorkspaceGitMutationResult<unknown>>>();

  constructor(
    private readonly options: {
      db: ZeusDatabase;
      deliveries: CommandDeliveryRepository;
      artifacts: ArtifactStore;
      redactSensitiveText(value: string): { text: string };
      now(): Date;
    },
  ) {}

  parse<TInput extends object>(input: { value: unknown; commandType: WorkspaceGitCommandType; scopeKind: WorkspaceGitScopeKind; scopeId: string }): ParsedWorkspaceGitMutation<TInput> {
    const request = requireRecord(input.value, 'Body');
    assertExactKeys(request, ['command', 'input'], input.commandType);
    const command = parseCommandEnvelope<WorkspaceGitCommandPayload>(request.command);
    if (command.commandType !== input.commandType) throw invalidCommand(`Expected commandType ${input.commandType}.`);
    if (command.scope.kind !== input.scopeKind || command.scope.id !== input.scopeId) throw invalidCommand('Command scope does not match the addressed Git/workspace resource.');
    if (command.expectedRevision !== null) throw invalidCommand('Workspace Git commands require expectedRevision=null.');
    assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], input.commandType);
    const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
    const declaredInputSha256 = validSha256(command.payload.inputSha256, 'command.payload.inputSha256');
    const commandInput = requireRecord(request.input, 'Body.input') as TInput;
    const inputSha256 = workspaceGitInputSha256(commandInput);
    if (inputSha256 !== declaredInputSha256) throw invalidCommand('Command inputSha256 does not match Body.input.');
    return { command, input: commandInput, inputSha256, operationIdentity };
  }

  executeExternal<TInput extends object, TResult>(input: {
    parsed: ParsedWorkspaceGitMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState?(result: TResult): void;
    mutateFailureBusinessState?(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<WorkspaceGitMutationResult<TResult>> {
    const activeKey = [input.parsed.command.commandId, input.parsed.command.commandType, input.parsed.command.scope.kind, input.parsed.command.scope.id, input.parsed.inputSha256, input.externalOperationId].join(':');
    const active = this.activeExternalExecutions.get(activeKey);
    if (active) return active as Promise<WorkspaceGitMutationResult<TResult>>;
    const execution = this.executeExternalOnce(input).finally(() => this.activeExternalExecutions.delete(activeKey));
    this.activeExternalExecutions.set(activeKey, execution as Promise<WorkspaceGitMutationResult<unknown>>);
    return execution;
  }

  private async executeExternalOnce<TInput extends object, TResult>(input: {
    parsed: ParsedWorkspaceGitMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState?(result: TResult): void;
    mutateFailureBusinessState?(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<WorkspaceGitMutationResult<TResult>> {
    const preparation = this.prepareExternal({
      parsed: input.parsed,
      destinationId: input.destinationId,
      resourceId: input.resourceId,
      externalOperationId: input.externalOperationId,
    });
    if (preparation.state === 'accepted_replay') {
      if (!preparation.receipt) throw missingResult(input.parsed.command.commandId);
      return {
        commandId: preparation.outbox.commandId,
        operationIdentity: input.parsed.operationIdentity,
        replayed: true,
        result: await this.readAcceptedResult<TResult>(preparation.receipt, input.parsed.command.commandType, input.externalOperationId),
      };
    }

    let writeStarted = false;
    try {
      this.options.deliveries.markExternalWriteStarted({ outboxId: preparation.outbox.id, occurredAt: this.options.now().toISOString() });
      writeStarted = true;
      const result = await input.invoke();
      assertReplayableResultSize(result);
      const resultArtifact = await this.options.artifacts.putJson({
        value: result,
        owner: resultOwner(input.parsed.command.commandId),
        mimeType: 'application/vnd.zeus.workspace-git-command-result+json',
        compression: 'gzip-v1',
        createdAt: this.options.now().toISOString(),
      });
      this.options.db.durableTransactionSync(() => {
        input.mutateAcceptedBusinessState?.(result);
        this.options.deliveries.recordOutcomeInCurrentTransaction({
          outboxId: preparation.outbox.id,
          outcome: 'accepted',
          evidence: acceptedEvidence(preparation.parsed, input.externalOperationId, resultArtifact),
          occurredAt: this.options.now().toISOString(),
        });
      });
      return { commandId: input.parsed.command.commandId, operationIdentity: input.parsed.operationIdentity, replayed: false, result };
    } catch (error) {
      const explicitlyRejected = writeStarted && (input.isExplicitRejection?.(error) ?? false);
      const outcome: Exclude<CommandDeliveryOutcome, 'accepted'> = explicitlyRejected ? 'explicitly_rejected' : writeStarted ? 'outcome_unknown_after_write' : 'failed_before_write';
      try {
        this.options.db.durableTransactionSync(() => {
          input.mutateFailureBusinessState?.(outcome, error);
          this.options.deliveries.recordOutcomeInCurrentTransaction({
            outboxId: preparation.outbox.id,
            outcome,
            evidence: {
              source: 'workspace_git_external_operation',
              commandType: input.parsed.command.commandType,
              operationIdentity: input.parsed.operationIdentity,
              externalOperationId: input.externalOperationId,
              result: outcome,
              error: serializeError(error, this.options.redactSensitiveText),
            },
            occurredAt: this.options.now().toISOString(),
          });
        });
      } catch (receiptError) {
        if (!isReceiptConflict(receiptError)) throw new AggregateError([error, receiptError], 'Workspace Git 外部操作与失败回执同时未能收口。');
      }
      if (outcome === 'outcome_unknown_after_write') throw outcomeUnknown(error, this.options.redactSensitiveText);
      throw error;
    }
  }

  private prepareExternal(input: { parsed: ParsedWorkspaceGitMutation<object>; destinationId: string; resourceId: string; externalOperationId: string }): ExternalPreparation {
    try {
      const delivery = this.options.deliveries.acceptAndPrepare({
        envelope: input.parsed.command,
        requestSha256: input.parsed.inputSha256,
        destinationKind: 'external_operation',
        destinationId: input.destinationId,
        resourceId: input.resourceId,
        externalOperationId: boundedIdentity(input.externalOperationId, 'externalOperationId'),
        occurredAt: this.options.now().toISOString(),
      });
      return { state: 'prepared', parsed: input.parsed, outbox: delivery.outbox };
    } catch (error) {
      if (!isCommandDeliveryError(error) || error.code !== 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED') throw error;
      const latest = this.options.deliveries.get(input.parsed.command.commandId)?.attempts.at(-1);
      if (!latest?.receipt || latest.outcome !== 'accepted') throw error;
      return { state: 'accepted_replay', parsed: input.parsed, outbox: latest, receipt: latest.receipt };
    }
  }

  private async readAcceptedResult<TResult>(receipt: CommandDeliveryReceiptRecord, commandType: string, externalOperationId: string): Promise<TResult> {
    try {
      const evidence = requireRecord(JSON.parse(receipt.evidenceJson) as unknown, 'receipt.evidence');
      const artifact = requireRecord(evidence.resultArtifact, 'receipt.evidence.resultArtifact');
      if (evidence.source !== 'workspace_git_external_operation' || evidence.commandType !== commandType || evidence.externalOperationId !== externalOperationId) {
        throw new Error('Accepted Workspace Git result identity mismatch.');
      }
      const stored = await this.options.artifacts.readAuthorized({
        sha256: validSha256(artifact.sha256, 'receipt.evidence.resultArtifact.sha256'),
        owner: { kind: 'command_delivery_result', id: receipt.commandId },
        maximumContentBytes: maximumReplayResultBytes,
      });
      if (artifact.contentSha256 !== stored.ref.contentSha256 || artifact.contentByteLength !== stored.ref.contentByteLength || artifact.generationId !== resultArtifactGeneration || stored.ref.generationId !== resultArtifactGeneration) {
        throw new Error('Accepted Workspace Git ArtifactRef does not match durable content.');
      }
      return JSON.parse(new TextDecoder().decode(stored.bytes)) as TResult;
    } catch (error) {
      if (error instanceof WorkspaceGitCommandApplicationError) throw error;
      throw missingResult(receipt.commandId);
    }
  }
}

export function workspaceGitInputSha256(input: unknown): string {
  return createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex');
}

function acceptedEvidence(parsed: ParsedWorkspaceGitMutation<object>, externalOperationId: string, artifact: ArtifactRef): Record<string, unknown> {
  return {
    source: 'workspace_git_external_operation',
    commandType: parsed.command.commandType,
    operationIdentity: parsed.operationIdentity,
    externalOperationId,
    resultArtifact: {
      sha256: artifact.sha256,
      contentSha256: artifact.contentSha256,
      contentByteLength: artifact.contentByteLength,
      generationId: resultArtifactGeneration,
    },
  };
}

function resultOwner(commandId: string) {
  return { kind: 'command_delivery_result', id: commandId, generationId: resultArtifactGeneration } as const;
}

function assertReplayableResultSize(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') + 1 > maximumReplayResultBytes) {
    throw new WorkspaceGitCommandApplicationError('ZEUS_WORKSPACE_GIT_COMMAND_RESULT_TOO_LARGE', `Workspace Git result exceeds the ${maximumReplayResultBytes}-byte immutable ArtifactRef replay budget.`, 500);
  }
}

function invalidCommand(message: string): WorkspaceGitCommandApplicationError {
  return new WorkspaceGitCommandApplicationError('ZEUS_WORKSPACE_GIT_COMMAND_INVALID', message, 400);
}

function missingResult(commandId: string): WorkspaceGitCommandApplicationError {
  return new WorkspaceGitCommandApplicationError('ZEUS_WORKSPACE_GIT_COMMAND_RESULT_MISSING', `Accepted Workspace Git command ${commandId} is missing its immutable result.`, 500);
}

function isCommandDeliveryError(error: unknown): error is CommandDeliveryStoreError {
  return Boolean(error) && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.startsWith('ZEUS_COMMAND_DELIVERY_');
}

function isReceiptConflict(error: unknown): boolean {
  return isCommandDeliveryError(error) && error.code === 'ZEUS_COMMAND_DELIVERY_RECEIPT_CONFLICT';
}

function serializeError(error: unknown, redactSensitiveText: (value: string) => { text: string }): Record<string, unknown> {
  if (error instanceof Error) {
    const code = 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? boundedScalar(error.code) : null;
    return { code, name: boundedScalar(error.name), message: boundedErrorMessage(error.message, redactSensitiveText) };
  }
  return { code: null, name: boundedScalar(typeof error), message: boundedErrorMessage(String(error), redactSensitiveText) };
}

function boundedErrorMessage(value: string, redactSensitiveText: (value: string) => { text: string }): string {
  const redacted = redactSensitiveText(value).text;
  const bytes = Buffer.from(redacted, 'utf8');
  if (bytes.byteLength <= maximumErrorMessageBytes) return redacted;
  return `${bytes
    .subarray(0, maximumErrorMessageBytes - 3)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')}...`;
}

function boundedScalar(value: string | number): string | number {
  return typeof value === 'number' ? value : value.slice(0, 128);
}

function outcomeUnknown(cause: unknown, redactSensitiveText: (value: string) => { text: string }): WorkspaceGitCommandApplicationError {
  const detail = boundedErrorMessage(cause instanceof Error ? cause.message : String(cause), redactSensitiveText);
  return new WorkspaceGitCommandApplicationError('ZEUS_WORKSPACE_GIT_COMMAND_OUTCOME_UNKNOWN', `Workspace Git result is unknown after the external write started: ${detail}`, 409, true);
}

export function workspaceGitCommandHttpError(error: unknown): { statusCode: number; payload: { error: string; message: string; recoveryRequired?: true } } | null {
  if (error instanceof WorkspaceGitCommandApplicationError) {
    return {
      statusCode: error.statusCode,
      payload: {
        error: error.code,
        message: error.message,
        ...(error.recoveryRequired ? { recoveryRequired: true as const } : {}),
      },
    };
  }
  if (error instanceof CommandEnvelopeError) return { statusCode: 400, payload: { error: error.code, message: error.message } };
  if (!isCommandDeliveryError(error)) return null;
  const recoveryRequired = error.code === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED';
  const statusCode = error.code === 'ZEUS_COMMAND_DELIVERY_NOT_FOUND' ? 404 : error.code === 'ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT' ? 400 : error.code === 'ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT' ? 500 : 409;
  return { statusCode, payload: { error: error.code, message: error.message, ...(recoveryRequired ? { recoveryRequired: true as const } : {}) } };
}
