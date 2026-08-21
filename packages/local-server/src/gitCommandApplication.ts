import { createHash } from 'node:crypto';
import { canonicalCommandInputJson, CommandEnvelopeError, parseCommandEnvelope, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { ArtifactStore, CommandDeliveryRepository, CommandDeliveryStoreError, type ArtifactRef, type CommandDeliveryOutcome, type CommandDeliveryReceiptRecord, type CommandOutboxRecord, type ZeusDatabase } from '@zeus/storage';

export const gitCommandTypes = {
  confirmationCreate: 'git.confirmation.create',
  confirmationConfirm: 'git.confirmation.confirm',
  confirmationReject: 'git.confirmation.reject',
  operationExecute: 'git.operation.execute',
  projectBranch: 'git.project.branch',
  projectCheckout: 'git.project.checkout',
  projectCommit: 'git.project.commit',
  projectStash: 'git.project.stash',
  projectApplyStash: 'git.project.apply_stash',
  projectPull: 'git.project.pull',
  projectPush: 'git.project.push',
  taskRollback: 'git.task.rollback',
} as const;

export type GitCommandType = (typeof gitCommandTypes)[keyof typeof gitCommandTypes];
export interface GitCommandPayload extends Record<string, unknown> {
  operationIdentity: string;
  inputSha256: string;
}
export interface GitCommandMutationRequest<TInput extends object> {
  command: CommandEnvelope<GitCommandPayload>;
  input: TInput;
}
export interface ParsedGitCommandMutation<TInput extends object> {
  command: CommandEnvelope<GitCommandPayload>;
  input: TInput;
  inputSha256: string;
  operationIdentity: string;
}
export interface GitCommandMutationResult<TResult> {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  result: TResult;
}

interface GitExternalPreparation {
  state: 'prepared' | 'accepted_replay';
  parsed: ParsedGitCommandMutation<object>;
  outbox: CommandOutboxRecord;
  receipt?: CommandDeliveryReceiptRecord;
}

export class GitCommandApplicationError extends Error {
  readonly name = 'GitCommandApplicationError';

  constructor(
    readonly code: 'ZEUS_GIT_COMMAND_INVALID' | 'ZEUS_GIT_COMMAND_RESULT_MISSING' | 'ZEUS_GIT_COMMAND_OUTCOME_UNKNOWN',
    message: string,
    readonly statusCode: number,
    readonly recoveryRequired = false,
  ) {
    super(message);
  }
}

const resultArtifactGeneration = 'git-command-result-v1';
// git-core 的 maxBuffer 为 20 MiB；JSON/UTF-8 结构开销计入后仍必须保证首次 accepted 的结果可重放。
const maximumReplayResultBytes = 32 * 1024 * 1024;
const maximumErrorMessageBytes = 2 * 1024;

/** Git 确认是进程内安全能力；只有真实 Git 写入进入带 write marker 的 External 四态账本。 */
export class GitCommandApplication {
  private readonly activeExternalExecutions = new Map<string, Promise<GitCommandMutationResult<unknown>>>();

  constructor(
    private readonly options: {
      db: ZeusDatabase;
      deliveries: CommandDeliveryRepository;
      artifacts: ArtifactStore;
      redactSensitiveText(value: string): { text: string };
      now(): Date;
    },
  ) {}

  parse<TInput extends object>(input: {
    value: unknown;
    commandType: GitCommandType;
    scopeKind: Extract<CommandScopeKind, 'approval' | 'git_repository'>;
    expectedScopeId(parsed: { input: TInput; operationIdentity: string }): string;
  }): ParsedGitCommandMutation<TInput> {
    const request = requireRecord(input.value, 'Body');
    assertExactKeys(request, ['command', 'input'], input.commandType);
    const command = parseCommandEnvelope<GitCommandPayload>(request.command);
    if (command.commandType !== input.commandType) throw invalidCommand(`Expected commandType ${input.commandType}.`);
    if (command.scope.kind !== input.scopeKind) throw invalidCommand(`Expected ${input.scopeKind} command scope.`);
    if (command.expectedRevision !== null) throw invalidCommand('Git commands require expectedRevision=null.');
    assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], input.commandType);
    const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
    const declaredInputSha256 = validSha256(command.payload.inputSha256, 'command.payload.inputSha256');
    const commandInput = requireRecord(request.input, 'Body.input') as TInput;
    const inputSha256 = gitCommandInputSha256(commandInput);
    if (inputSha256 !== declaredInputSha256) throw invalidCommand('Command inputSha256 does not match Body.input.');
    if (command.scope.id !== input.expectedScopeId({ input: commandInput, operationIdentity })) throw invalidCommand('Command scope does not match the addressed Git resource.');
    return { command, input: commandInput, inputSha256, operationIdentity };
  }

  executeExternal<TInput extends object, TResult>(input: {
    parsed: ParsedGitCommandMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState(result: TResult): void;
  }): Promise<GitCommandMutationResult<TResult>> {
    const activeKey = [input.parsed.command.commandId, input.parsed.command.commandType, input.parsed.command.scope.kind, input.parsed.command.scope.id, input.parsed.inputSha256, input.parsed.operationIdentity].join(':');
    const active = this.activeExternalExecutions.get(activeKey);
    if (active) return active as Promise<GitCommandMutationResult<TResult>>;
    const execution = this.executeExternalOnce(input).finally(() => this.activeExternalExecutions.delete(activeKey));
    this.activeExternalExecutions.set(activeKey, execution as Promise<GitCommandMutationResult<unknown>>);
    return execution;
  }

  private async executeExternalOnce<TInput extends object, TResult>(input: {
    parsed: ParsedGitCommandMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState(result: TResult): void;
  }): Promise<GitCommandMutationResult<TResult>> {
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
        result: await this.readAcceptedResult<TResult>(preparation.receipt, input.parsed.command.commandType),
      };
    }

    let writeStarted = false;
    try {
      await input.beforeWrite?.();
      this.options.deliveries.markExternalWriteStarted({ outboxId: preparation.outbox.id, occurredAt: this.options.now().toISOString() });
      writeStarted = true;
      const result = await input.invoke();
      assertReplayableResultSize(result);
      const resultArtifact = await this.options.artifacts.putJson({
        value: result,
        owner: resultOwner(input.parsed.command.commandId),
        mimeType: 'application/vnd.zeus.git-command-result+json',
        compression: 'gzip-v1',
        createdAt: this.options.now().toISOString(),
      });
      this.options.db.durableTransactionSync(() => {
        input.mutateAcceptedBusinessState(result);
        this.options.deliveries.recordOutcomeInCurrentTransaction({
          outboxId: preparation.outbox.id,
          outcome: 'accepted',
          evidence: acceptedEvidence(preparation.parsed, preparation.outbox.externalOperationId, resultArtifact),
          occurredAt: this.options.now().toISOString(),
        });
      });
      return { commandId: input.parsed.command.commandId, operationIdentity: input.parsed.operationIdentity, replayed: false, result };
    } catch (error) {
      const outcome: Exclude<CommandDeliveryOutcome, 'accepted'> = writeStarted ? 'outcome_unknown_after_write' : 'failed_before_write';
      try {
        this.options.db.durableTransactionSync(() => {
          this.options.deliveries.recordOutcomeInCurrentTransaction({
            outboxId: preparation.outbox.id,
            outcome,
            evidence: {
              source: 'git_external_operation',
              commandType: input.parsed.command.commandType,
              operationIdentity: input.parsed.operationIdentity,
              externalOperationId: preparation.outbox.externalOperationId,
              result: outcome,
              error: serializeError(error, this.options.redactSensitiveText),
            },
            occurredAt: this.options.now().toISOString(),
          });
        });
      } catch (receiptError) {
        if (!isReceiptConflict(receiptError)) throw new AggregateError([error, receiptError], 'Git 外部操作与失败回执同时未能收口。');
      }
      if (writeStarted) throw outcomeUnknown(error, this.options.redactSensitiveText);
      throw error;
    }
  }

  private prepareExternal(input: { parsed: ParsedGitCommandMutation<object>; destinationId: string; resourceId: string; externalOperationId: string }): GitExternalPreparation {
    try {
      const delivery = this.options.deliveries.acceptAndPrepare({
        envelope: input.parsed.command,
        requestSha256: input.parsed.inputSha256,
        destinationKind: 'external_operation',
        destinationId: input.destinationId,
        resourceId: input.resourceId,
        externalOperationId: input.externalOperationId,
        occurredAt: this.options.now().toISOString(),
      });
      return { state: 'prepared', parsed: input.parsed, outbox: delivery.outbox };
    } catch (error) {
      if (!isCommandDeliveryStoreError(error) || error.code !== 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED') throw error;
      const latest = this.options.deliveries.get(input.parsed.command.commandId)?.attempts.at(-1);
      if (!latest?.receipt || latest.outcome !== 'accepted') throw error;
      return { state: 'accepted_replay', parsed: input.parsed, outbox: latest, receipt: latest.receipt };
    }
  }

  private async readAcceptedResult<TResult>(receipt: CommandDeliveryReceiptRecord, commandType: string): Promise<TResult> {
    try {
      const evidence = JSON.parse(receipt.evidenceJson) as Record<string, unknown>;
      const artifact = requireRecord(evidence.resultArtifact, 'receipt.evidence.resultArtifact');
      if (evidence.source !== 'git_external_operation' || evidence.commandType !== commandType) throw new Error('Accepted Git result identity mismatch.');
      const stored = await this.options.artifacts.readAuthorized({
        sha256: validSha256(artifact.sha256, 'receipt.evidence.resultArtifact.sha256'),
        owner: { kind: 'command_delivery_result', id: receipt.commandId },
        maximumContentBytes: maximumReplayResultBytes,
      });
      if (artifact.contentSha256 !== stored.ref.contentSha256 || artifact.contentByteLength !== stored.ref.contentByteLength || artifact.generationId !== resultArtifactGeneration || stored.ref.generationId !== resultArtifactGeneration) {
        throw new Error('Accepted Git result ArtifactRef does not match durable content.');
      }
      return JSON.parse(new TextDecoder().decode(stored.bytes)) as TResult;
    } catch (error) {
      if (error instanceof GitCommandApplicationError) throw error;
      throw missingResult(receipt.commandId);
    }
  }
}

export function gitCommandInputSha256(input: unknown): string {
  return createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex');
}

function acceptedEvidence(parsed: ParsedGitCommandMutation<object>, externalOperationId: string | null, artifact: ArtifactRef): Record<string, unknown> {
  return {
    source: 'git_external_operation',
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
    throw new Error(`Git command result exceeds the ${maximumReplayResultBytes}-byte immutable replay budget.`);
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidCommand(`${field} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidCommand(`${field} must be a plain object.`);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], commandType: string): void {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (actual.length === normalizedExpected.length && actual.every((key, index) => key === normalizedExpected[index])) return;
  throw invalidCommand(`${commandType} must contain exactly: ${normalizedExpected.join(', ')}.`);
}

function boundedIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 512 || Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 31 || character.codePointAt(0) === 127)) {
    throw invalidCommand(`${field} is invalid.`);
  }
  return value;
}

function validSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw invalidCommand(`${field} must be a lowercase SHA-256.`);
  return value;
}

function serializeError(error: unknown, redactSensitiveText: (value: string) => { text: string }): Record<string, unknown> {
  if (error instanceof Error) {
    const code = 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? boundedScalar(error.code) : null;
    return { code, name: boundedScalar(error.name), message: boundedErrorMessage(error.message, redactSensitiveText) };
  }
  return { code: null, name: boundedScalar(typeof error), message: boundedErrorMessage(String(error), redactSensitiveText) };
}

function invalidCommand(message: string): GitCommandApplicationError {
  return new GitCommandApplicationError('ZEUS_GIT_COMMAND_INVALID', message, 400);
}

function missingResult(commandId: string): GitCommandApplicationError {
  return new GitCommandApplicationError('ZEUS_GIT_COMMAND_RESULT_MISSING', `Accepted Git command ${commandId} is missing its immutable result.`, 500);
}

function outcomeUnknown(cause: unknown, redactSensitiveText: (value: string) => { text: string }): GitCommandApplicationError {
  const detail = boundedErrorMessage(cause instanceof Error ? cause.message : String(cause), redactSensitiveText);
  return new GitCommandApplicationError('ZEUS_GIT_COMMAND_OUTCOME_UNKNOWN', `Git command result is unknown after write started: ${detail}`, 409, true);
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

function isCommandDeliveryStoreError(error: unknown): error is CommandDeliveryStoreError {
  return Boolean(error) && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.startsWith('ZEUS_COMMAND_DELIVERY_');
}

function isReceiptConflict(error: unknown): boolean {
  return isCommandDeliveryStoreError(error) && error.code === 'ZEUS_COMMAND_DELIVERY_RECEIPT_CONFLICT';
}

export function gitCommandHttpError(error: unknown): { statusCode: number; payload: { error: string; message: string; recoveryRequired?: true } } | null {
  if (error instanceof GitCommandApplicationError) {
    return { statusCode: error.statusCode, payload: { error: error.code, message: error.message, ...(error.recoveryRequired ? { recoveryRequired: true as const } : {}) } };
  }
  if (error instanceof CommandEnvelopeError) return { statusCode: 400, payload: { error: error.code, message: error.message } };
  if (!isCommandDeliveryStoreError(error)) return null;
  const recoveryRequired = error.code === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED';
  const statusCode = error.code === 'ZEUS_COMMAND_DELIVERY_NOT_FOUND' ? 404 : error.code === 'ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT' ? 400 : error.code === 'ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT' ? 500 : 409;
  return { statusCode, payload: { error: error.code, message: error.message, ...(recoveryRequired ? { recoveryRequired: true as const } : {}) } };
}
