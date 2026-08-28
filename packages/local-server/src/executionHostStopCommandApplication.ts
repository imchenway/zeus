import { createHash } from 'node:crypto';
import {
  canonicalCommandInputJson,
  CommandEnvelopeError,
  executionHostStopActiveCommandType,
  executionHostStopActiveScopeId,
  parseCommandEnvelope,
  type ExecutionHostStopActiveCommandRequest,
  type ExecutionHostStopActiveCommandResponse,
  type ExecutionHostStopActiveInput,
  type ExecutionHostStopActiveResult,
} from '@zeus/shared';
import { CommandDeliveryRepository, CommandDeliveryStoreError, type CommandDeliveryOutcome, type CommandDeliveryReceiptRecord, type CommandOutboxRecord, type ZeusDatabase } from '@zeus/storage';

export interface ParsedExecutionHostStopActiveCommand {
  command: ExecutionHostStopActiveCommandRequest['command'];
  input: ExecutionHostStopActiveInput;
  inputSha256: string;
  operationIdentity: string;
}

interface PreparedExternal {
  state: 'prepared';
  parsed: ParsedExecutionHostStopActiveCommand;
  outbox: CommandOutboxRecord;
}

interface AcceptedReplay {
  state: 'accepted_replay';
  parsed: ParsedExecutionHostStopActiveCommand;
  outbox: CommandOutboxRecord;
  receipt: CommandDeliveryReceiptRecord;
}

export class ExecutionHostStopCommandApplicationError extends Error {
  readonly name = 'ExecutionHostStopCommandApplicationError';

  constructor(
    readonly code: 'ZEUS_EXECUTION_HOST_STOP_COMMAND_INVALID' | 'ZEUS_EXECUTION_HOST_STOP_RESULT_INVALID' | 'ZEUS_EXECUTION_HOST_STOP_RESULT_MISSING' | 'ZEUS_EXECUTION_HOST_STOP_OUTCOME_UNKNOWN',
    message: string,
    readonly statusCode: 400 | 409 | 500,
    readonly recoveryRequired = false,
  ) {
    super(message);
  }
}

export const executionHostStopCommandPolicy = {
  classification: 'external_operation',
  outcomes: ['failed_before_write', 'explicitly_rejected', 'outcome_unknown_after_write', 'accepted'],
  destinationId: 'execution-host-control',
  resourceId: executionHostStopActiveScopeId,
  receiptMaximumBytes: 64 * 1024,
  errorMaximumBytes: 2 * 1024,
  failedTurnMaximumEntries: 16,
  failedTurnMessageMaximumBytes: 512,
  automaticRetryAfterUnknown: false,
} as const;

/**
 * “停止并退出”是一次复合外部操作：Provider/process 信号前先提交 write marker；本机业务事实
 * 已耐久后才写 accepted receipt。崩溃窗口只能收口为 unknown，同一命令禁止再次发信号。
 */
export class ExecutionHostStopCommandApplication {
  private readonly activeExecutions = new Map<string, Promise<ExecutionHostStopActiveCommandResponse>>();

  constructor(
    private readonly options: {
      db: ZeusDatabase;
      deliveries: CommandDeliveryRepository;
      redactSensitiveText(value: string): { text: string };
      now(): Date;
    },
  ) {}

  parse(value: unknown): ParsedExecutionHostStopActiveCommand {
    const request = requireRecord(value, 'Body');
    assertExactKeys(request, ['command', 'input'], executionHostStopActiveCommandType);
    const command = parseCommandEnvelope<ExecutionHostStopActiveCommandRequest['command']['payload']>(request.command);
    if (command.commandType !== executionHostStopActiveCommandType) throw invalidCommand(`Expected commandType ${executionHostStopActiveCommandType}.`);
    if (command.scope.kind !== 'execution_host' || command.scope.id !== executionHostStopActiveScopeId) {
      throw invalidCommand(`Expected execution_host/${executionHostStopActiveScopeId} command scope.`);
    }
    if (command.expectedRevision !== null) throw invalidCommand('Execution Host stop command requires expectedRevision=null.');
    assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], executionHostStopActiveCommandType);
    const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
    const declaredInputSha256 = validSha256(command.payload.inputSha256, 'command.payload.inputSha256');
    const rawInput = requireRecord(request.input, 'Body.input');
    assertExactKeys(rawInput, ['reason'], executionHostStopActiveCommandType);
    if (rawInput.reason !== 'user_stop_active_and_quit' && rawInput.reason !== 'embedded_owner_retirement') throw invalidCommand('Execution Host stop reason is invalid.');
    const input: ExecutionHostStopActiveInput = { reason: rawInput.reason };
    const inputSha256 = executionHostStopActiveInputSha256(input);
    if (inputSha256 !== declaredInputSha256) throw invalidCommand('Command inputSha256 does not match Body.input.');
    return { command, input, inputSha256, operationIdentity };
  }

  execute(input: {
    parsed: ParsedExecutionHostStopActiveCommand;
    beforeWrite?(): Promise<void>;
    invoke(): Promise<ExecutionHostStopActiveResult>;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<ExecutionHostStopActiveCommandResponse> {
    const activeKey = [input.parsed.command.commandId, input.parsed.inputSha256, input.parsed.operationIdentity].join(':');
    const active = this.activeExecutions.get(activeKey);
    if (active) return active;
    const execution = this.executeOnce(input).finally(() => this.activeExecutions.delete(activeKey));
    this.activeExecutions.set(activeKey, execution);
    return execution;
  }

  private async executeOnce(input: {
    parsed: ParsedExecutionHostStopActiveCommand;
    beforeWrite?(): Promise<void>;
    invoke(): Promise<ExecutionHostStopActiveResult>;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<ExecutionHostStopActiveCommandResponse> {
    const preparation = this.prepare(input.parsed);
    if (preparation.state === 'accepted_replay') {
      return {
        commandId: preparation.outbox.commandId,
        operationIdentity: input.parsed.operationIdentity,
        replayed: true,
        result: readAcceptedResult(preparation.receipt),
      };
    }

    let writeStarted = false;
    try {
      await input.beforeWrite?.();
      this.options.deliveries.markExternalWriteStarted({ outboxId: preparation.outbox.id, occurredAt: this.options.now().toISOString() });
      writeStarted = true;
      const result = validateStopResult(await input.invoke());
      const evidence = acceptedEvidence(preparation.parsed, preparation.outbox.externalOperationId, result);
      assertJsonBudget(evidence, executionHostStopCommandPolicy.receiptMaximumBytes, 'Execution Host stop receipt');
      this.options.db.durableTransactionSync(() => {
        this.options.deliveries.recordOutcomeInCurrentTransaction({
          outboxId: preparation.outbox.id,
          outcome: 'accepted',
          evidence,
          occurredAt: this.options.now().toISOString(),
        });
      });
      return {
        commandId: input.parsed.command.commandId,
        operationIdentity: input.parsed.operationIdentity,
        replayed: false,
        result,
      };
    } catch (error) {
      const outcome: Exclude<CommandDeliveryOutcome, 'accepted'> = writeStarted && input.isExplicitRejection?.(error) ? 'explicitly_rejected' : writeStarted ? 'outcome_unknown_after_write' : 'failed_before_write';
      try {
        this.options.db.durableTransactionSync(() => {
          this.options.deliveries.recordOutcomeInCurrentTransaction({
            outboxId: preparation.outbox.id,
            outcome,
            evidence: {
              source: 'execution_host_stop_external_operation',
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
        if (!isReceiptConflict(receiptError)) throw new AggregateError([error, receiptError], 'Execution Host 停止操作与失败回执同时未能收口。');
      }
      if (outcome === 'outcome_unknown_after_write') throw outcomeUnknown(error, this.options.redactSensitiveText);
      throw error;
    }
  }

  private prepare(parsed: ParsedExecutionHostStopActiveCommand): PreparedExternal | AcceptedReplay {
    try {
      const delivery = this.options.deliveries.acceptAndPrepare({
        envelope: parsed.command,
        requestSha256: parsed.inputSha256,
        destinationKind: 'external_operation',
        destinationId: executionHostStopCommandPolicy.destinationId,
        resourceId: executionHostStopCommandPolicy.resourceId,
        externalOperationId: parsed.operationIdentity,
        occurredAt: this.options.now().toISOString(),
      });
      return { state: 'prepared', parsed, outbox: delivery.outbox };
    } catch (error) {
      if (!isCommandDeliveryError(error) || error.code !== 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED') throw error;
      const latest = this.options.deliveries.get(parsed.command.commandId)?.attempts.at(-1);
      if (!latest?.receipt || latest.outcome !== 'accepted') throw error;
      return { state: 'accepted_replay', parsed, outbox: latest, receipt: latest.receipt };
    }
  }
}

export function executionHostStopActiveInputSha256(input: unknown): string {
  return createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex');
}

function acceptedEvidence(parsed: ParsedExecutionHostStopActiveCommand, externalOperationId: string | null, result: ExecutionHostStopActiveResult): Record<string, unknown> {
  return {
    source: 'execution_host_stop_external_operation',
    commandType: parsed.command.commandType,
    operationIdentity: parsed.operationIdentity,
    externalOperationId,
    result,
  };
}

function readAcceptedResult(receipt: CommandDeliveryReceiptRecord): ExecutionHostStopActiveResult {
  try {
    const evidence = requireRecord(JSON.parse(receipt.evidenceJson), 'receipt.evidence');
    if (evidence.source !== 'execution_host_stop_external_operation' || evidence.commandType !== executionHostStopActiveCommandType) {
      throw new Error('Accepted Execution Host stop result identity mismatch.');
    }
    return validateStopResult(evidence.result);
  } catch (error) {
    if (error instanceof ExecutionHostStopCommandApplicationError) throw error;
    throw missingResult(receipt.commandId);
  }
}

function validateStopResult(value: unknown): ExecutionHostStopActiveResult {
  const result = requireResultRecord(value, 'Execution Host stop result');
  assertExactResultKeys(result, [
    'closedSubmissionCount',
    'failedGoalPauseCount',
    'failedRequestCount',
    'failedTurns',
    'providerOutcomeUnconfirmed',
    'providerInterruptFailureCount',
    'requestedAt',
    'requestedTurnCount',
    'stoppedCommandRunCount',
    'stoppedRuntimeCount',
  ]);
  const failedTurns = Array.isArray(result.failedTurns) ? result.failedTurns : null;
  if (!failedTurns || failedTurns.length > executionHostStopCommandPolicy.failedTurnMaximumEntries) {
    throw invalidResult('Execution Host stop failedTurns exceeds its bounded entry budget.');
  }
  const normalizedFailures = failedTurns.map((entry) => {
    const failure = requireResultRecord(entry, 'Execution Host stop failure');
    assertExactResultKeys(failure, ['conversationId', 'message', 'providerTurnId']);
    const message = boundedText(failure.message, 'failedTurns.message', executionHostStopCommandPolicy.failedTurnMessageMaximumBytes);
    return {
      conversationId: boundedIdentity(failure.conversationId, 'failedTurns.conversationId'),
      providerTurnId: boundedIdentity(failure.providerTurnId, 'failedTurns.providerTurnId'),
      message,
    };
  });
  const requestedAt = typeof result.requestedAt === 'string' && Number.isFinite(Date.parse(result.requestedAt)) ? result.requestedAt : null;
  if (!requestedAt || typeof result.providerOutcomeUnconfirmed !== 'boolean') throw invalidResult('Execution Host stop result timestamp or Provider outcome boundary is invalid.');
  return {
    requestedTurnCount: nonNegativeInteger(result.requestedTurnCount, 'requestedTurnCount'),
    providerInterruptFailureCount: nonNegativeInteger(result.providerInterruptFailureCount, 'providerInterruptFailureCount'),
    closedSubmissionCount: nonNegativeInteger(result.closedSubmissionCount, 'closedSubmissionCount'),
    failedRequestCount: nonNegativeInteger(result.failedRequestCount, 'failedRequestCount'),
    stoppedRuntimeCount: nonNegativeInteger(result.stoppedRuntimeCount, 'stoppedRuntimeCount'),
    stoppedCommandRunCount: nonNegativeInteger(result.stoppedCommandRunCount, 'stoppedCommandRunCount'),
    failedGoalPauseCount: nonNegativeInteger(result.failedGoalPauseCount, 'failedGoalPauseCount'),
    failedTurns: normalizedFailures,
    providerOutcomeUnconfirmed: result.providerOutcomeUnconfirmed,
    requestedAt,
  };
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalidResult(`Execution Host stop ${field} is invalid.`);
  return Number(value);
}

function assertJsonBudget(value: unknown, maximumBytes: number, label: string): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maximumBytes) throw invalidResult(`${label} exceeds the ${maximumBytes}-byte budget.`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidCommand(`${field} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidCommand(`${field} must be a plain object.`);
  return value as Record<string, unknown>;
}

function requireResultRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResult(`${field} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidResult(`${field} must be a plain object.`);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], commandType: string): void {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (actual.length === normalizedExpected.length && actual.every((key, index) => key === normalizedExpected[index])) return;
  throw invalidCommand(`${commandType} must contain exactly: ${normalizedExpected.join(', ')}.`);
}

function assertExactResultKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (actual.length === normalizedExpected.length && actual.every((key, index) => key === normalizedExpected[index])) return;
  throw invalidResult(`Execution Host stop result must contain exactly: ${normalizedExpected.join(', ')}.`);
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

function boundedText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumBytes) throw invalidResult(`${field} exceeds its byte budget.`);
  return value;
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
  if (bytes.byteLength <= executionHostStopCommandPolicy.errorMaximumBytes) return redacted;
  return `${bytes
    .subarray(0, executionHostStopCommandPolicy.errorMaximumBytes - 3)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')}...`;
}

function boundedScalar(value: string | number): string | number {
  return typeof value === 'number' ? value : value.slice(0, 128);
}

function invalidCommand(message: string): ExecutionHostStopCommandApplicationError {
  return new ExecutionHostStopCommandApplicationError('ZEUS_EXECUTION_HOST_STOP_COMMAND_INVALID', message, 400);
}

function invalidResult(message: string): ExecutionHostStopCommandApplicationError {
  return new ExecutionHostStopCommandApplicationError('ZEUS_EXECUTION_HOST_STOP_RESULT_INVALID', message, 500);
}

function missingResult(commandId: string): ExecutionHostStopCommandApplicationError {
  return new ExecutionHostStopCommandApplicationError('ZEUS_EXECUTION_HOST_STOP_RESULT_MISSING', `Accepted Execution Host stop command ${commandId} is missing its immutable result.`, 500);
}

function outcomeUnknown(cause: unknown, redactSensitiveText: (value: string) => { text: string }): ExecutionHostStopCommandApplicationError {
  const detail = boundedErrorMessage(cause instanceof Error ? cause.message : String(cause), redactSensitiveText);
  return new ExecutionHostStopCommandApplicationError('ZEUS_EXECUTION_HOST_STOP_OUTCOME_UNKNOWN', `Execution Host stop result is unknown after external write started: ${detail}`, 409, true);
}

function isCommandDeliveryError(error: unknown): error is CommandDeliveryStoreError {
  return Boolean(error) && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.startsWith('ZEUS_COMMAND_DELIVERY_');
}

function isReceiptConflict(error: unknown): boolean {
  return isCommandDeliveryError(error) && error.code === 'ZEUS_COMMAND_DELIVERY_RECEIPT_CONFLICT';
}

export function executionHostStopCommandHttpError(error: unknown): { statusCode: number; payload: { error: string; message: string; recoveryRequired?: true } } | null {
  if (error instanceof ExecutionHostStopCommandApplicationError) {
    return { statusCode: error.statusCode, payload: { error: error.code, message: error.message, ...(error.recoveryRequired ? { recoveryRequired: true as const } : {}) } };
  }
  if (error instanceof CommandEnvelopeError) return { statusCode: 400, payload: { error: error.code, message: error.message } };
  if (!isCommandDeliveryError(error)) return null;
  const recoveryRequired = error.code === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED';
  const statusCode = error.code === 'ZEUS_COMMAND_DELIVERY_NOT_FOUND' ? 404 : error.code === 'ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT' ? 400 : error.code === 'ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT' ? 500 : 409;
  return { statusCode, payload: { error: error.code, message: error.message, ...(recoveryRequired ? { recoveryRequired: true as const } : {}) } };
}
