import { createHash, randomUUID } from 'node:crypto';
import { commandEnvelopeSchemaGeneration, CommandEnvelopeError, parseCommandEnvelope, type CommandActor, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { CommandDeliveryRepository, CommandDeliveryStoreError, type CommandDeliveryOutcome, type CommandDeliveryReceiptRecord, type CommandOutboxRecord, type ZeusDatabase } from '@zeus/storage';

export const commandCenterCommandTypes = {
  definitionCreate: 'command_center.definition.create',
  definitionUpdate: 'command_center.definition.update',
  definitionDelete: 'command_center.definition.delete',
  confirmationCreate: 'command_center.confirmation.create',
  runStart: 'command_center.run.start',
  runStop: 'command_center.run.stop',
} as const;

export type CommandCenterCommandType = (typeof commandCenterCommandTypes)[keyof typeof commandCenterCommandTypes];
export type CommandCenterCommandPayload = { operationIdentity: string; inputSha256: string };

export interface CommandCenterMutationRequest<TInput extends object> {
  command: CommandEnvelope<CommandCenterCommandPayload>;
  input: TInput;
}

export interface ParsedCommandCenterMutation<TInput extends object> {
  command: CommandEnvelope<CommandCenterCommandPayload>;
  input: TInput;
  inputSha256: string;
  operationIdentity: string;
}

export interface CommandCenterMutationResult<TResult> {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  result: TResult;
}

export interface PreparedCommandCenterExternal {
  state: 'prepared';
  parsed: ParsedCommandCenterMutation<object>;
  outbox: CommandOutboxRecord;
  replayedPreparation: boolean;
  acceptedReplayResult?: never;
}

export interface ReplayedCommandCenterExternal<TResult> {
  state: 'accepted_replay';
  parsed: ParsedCommandCenterMutation<object>;
  outbox: CommandOutboxRecord;
  replayedPreparation: true;
  acceptedReplayResult: TResult;
}

export type CommandCenterExternalPreparation<TResult> = PreparedCommandCenterExternal | ReplayedCommandCenterExternal<TResult>;

export class CommandCenterCommandApplicationError extends Error {
  readonly name = 'CommandCenterCommandApplicationError';

  constructor(
    readonly code: 'ZEUS_COMMAND_CENTER_COMMAND_INVALID' | 'ZEUS_COMMAND_CENTER_RESULT_MISSING',
    message: string,
    readonly statusCode: 400 | 409 | 500,
  ) {
    super(message);
  }
}

/**
 * Command Center 的统一命令边界：输入正文与 Envelope 分离，Core mutation 与 accepted
 * receipt 同事务；外部操作则先耐久 write marker，再以不可变结果收口。
 */
export class CommandCenterCommandApplication {
  constructor(
    private readonly options: {
      db: ZeusDatabase;
      deliveries: CommandDeliveryRepository;
      now(): Date;
    },
  ) {}

  parse<TInput extends object>(input: {
    value: unknown;
    commandType: CommandCenterCommandType;
    scopeKind: CommandScopeKind;
    expectedScopeId?: (parsed: { input: TInput; operationIdentity: string }) => string;
  }): ParsedCommandCenterMutation<TInput> {
    const request = requireRecord(input.value, 'Body');
    assertExactKeys(request, ['command', 'input'], input.commandType);
    const command = parseCommandEnvelope<CommandCenterCommandPayload>(request.command);
    if (command.commandType !== input.commandType) {
      throw invalidCommand(`Expected commandType ${input.commandType}.`);
    }
    if (command.scope.kind !== input.scopeKind) {
      throw invalidCommand(`Expected ${input.scopeKind} command scope.`);
    }
    if (input.scopeKind === 'command_run' && !/^command_run_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(command.scope.id)) {
      throw invalidCommand('command_run scope.id must be a path-safe Command Center run identity.');
    }
    assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], input.commandType);
    const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
    const declaredInputSha256 = validSha256(command.payload.inputSha256, 'command.payload.inputSha256');
    const commandInput = requireRecord(request.input, 'Body.input') as TInput;
    const inputSha256 = commandCenterInputSha256(commandInput);
    if (inputSha256 !== declaredInputSha256) throw invalidCommand('Command inputSha256 does not match Body.input.');
    const expectedScopeId = input.expectedScopeId?.({ input: commandInput, operationIdentity });
    if (expectedScopeId !== undefined && command.scope.id !== expectedScopeId) {
      throw invalidCommand('Command scope does not match the addressed Command Center resource.');
    }
    return { command, input: commandInput, inputSha256, operationIdentity };
  }

  executeCore<TInput extends object, TResult>(input: { parsed: ParsedCommandCenterMutation<TInput>; destinationId: string; resourceId: string; mutateBusinessState(): TResult }): CommandCenterMutationResult<TResult> {
    let result: TResult | undefined;
    const evidence: CommandCenterResultEvidence<TResult> = {
      source: 'command_center_application',
      commandType: input.parsed.command.commandType,
      operationIdentity: input.parsed.operationIdentity,
      result: null,
    };
    const delivery = this.options.deliveries.executeCoreApplication({
      envelope: input.parsed.command,
      requestSha256: input.parsed.inputSha256,
      destinationId: input.destinationId,
      resourceId: input.resourceId,
      operationIdentity: input.parsed.operationIdentity,
      occurredAt: this.options.now().toISOString(),
      evidence,
      mutateBusinessState: () => {
        result = input.mutateBusinessState();
        evidence.result = result;
      },
    });
    const resolved = delivery.created ? result : readCommandCenterResult<TResult>(delivery.receipt);
    if (resolved === undefined) throw missingResult(input.parsed.command.commandId);
    return {
      commandId: delivery.inbox.commandId,
      operationIdentity: input.parsed.operationIdentity,
      replayed: !delivery.created,
      result: resolved,
    };
  }

  prepareExternal<TInput extends object, TResult>(input: {
    parsed: ParsedCommandCenterMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    mutatePreparedBusinessState?(): void;
  }): CommandCenterExternalPreparation<TResult> {
    try {
      const delivery = this.options.deliveries.acceptAndPrepare({
        envelope: input.parsed.command,
        requestSha256: input.parsed.inputSha256,
        destinationKind: 'external_operation',
        destinationId: input.destinationId,
        resourceId: input.resourceId,
        externalOperationId: input.externalOperationId,
        occurredAt: this.options.now().toISOString(),
        mutateBusinessState: input.mutatePreparedBusinessState,
      });
      return {
        state: 'prepared',
        parsed: input.parsed as ParsedCommandCenterMutation<object>,
        outbox: delivery.outbox,
        replayedPreparation: !delivery.created,
      };
    } catch (error) {
      if (!isCommandDeliveryStoreError(error) || error.code !== 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED') throw error;
      const snapshot = this.options.deliveries.get(input.parsed.command.commandId);
      const accepted = snapshot?.attempts.at(-1);
      if (!accepted?.receipt || accepted.outcome !== 'accepted') throw error;
      return {
        state: 'accepted_replay',
        parsed: input.parsed as ParsedCommandCenterMutation<object>,
        outbox: accepted,
        replayedPreparation: true,
        acceptedReplayResult: readCommandCenterResult<TResult>(accepted.receipt),
      };
    }
  }

  markExternalWriteStarted(preparation: PreparedCommandCenterExternal): CommandOutboxRecord {
    return this.options.deliveries.markExternalWriteStarted({
      outboxId: preparation.outbox.id,
      occurredAt: this.options.now().toISOString(),
    });
  }

  resolveExternal<TResult>(input: { preparation: PreparedCommandCenterExternal; outcome: CommandDeliveryOutcome; evidence: Record<string, unknown>; mutateBusinessState(): TResult }): CommandCenterMutationResult<TResult> {
    if (input.outcome === 'accepted') {
      const attempt = this.options.deliveries.get(input.preparation.parsed.command.commandId)?.attempts.find((candidate) => candidate.id === input.preparation.outbox.id);
      if (!attempt?.providerWriteStartedAt) {
        throw new CommandDeliveryStoreError('ZEUS_COMMAND_DELIVERY_STATE_CONFLICT', 'External operation 只有在耐久 write marker 之后才能记录 accepted。', {
          commandId: input.preparation.parsed.command.commandId,
          outboxId: input.preparation.outbox.id,
        });
      }
    }
    let result: TResult | undefined;
    let receipt: CommandDeliveryReceiptRecord | undefined;
    this.options.db.durableTransactionSync(() => {
      result = input.mutateBusinessState();
      receipt = this.options.deliveries.recordOutcomeInCurrentTransaction({
        outboxId: input.preparation.outbox.id,
        outcome: input.outcome,
        evidence: {
          source: 'command_center_external_operation',
          commandType: input.preparation.parsed.command.commandType,
          externalOperationId: input.preparation.outbox.externalOperationId,
          ...input.evidence,
          result,
        },
        occurredAt: this.options.now().toISOString(),
      });
    });
    if (result === undefined || !receipt) throw missingResult(input.preparation.parsed.command.commandId);
    return {
      commandId: receipt.commandId,
      operationIdentity: input.preparation.parsed.operationIdentity,
      replayed: false,
      result,
    };
  }
}

interface CommandCenterResultEvidence<TResult> {
  source: 'command_center_application';
  commandType: string;
  operationIdentity: string;
  result: TResult | null;
}

export function commandCenterInputSha256(input: unknown): string {
  return createHash('sha256').update(canonicalCommandCenterJson(input)).digest('hex');
}

/** Core 内部适配器（如 Telegram）也必须生成与公开 HTTP 完全相同的 Envelope，而不能旁路写入口。 */
export function createCommandCenterCommandRequest<TInput extends object>(input: {
  commandType: CommandCenterCommandType;
  actor: CommandActor;
  scope: { kind: Extract<CommandScopeKind, 'command_definition' | 'command_run'>; id: string };
  expectedRevision: number | null;
  operationIdentity: string;
  value: TInput;
}): CommandCenterMutationRequest<TInput> {
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: `command_command_center_${randomUUID()}`,
      commandType: input.commandType,
      actor: input.actor,
      scope: input.scope,
      expectedRevision: input.expectedRevision,
      idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
      issuedAt: new Date().toISOString(),
      payload: { operationIdentity: input.operationIdentity, inputSha256: commandCenterInputSha256(input.value) },
    },
    input: input.value,
  };
}

export function canonicalCommandCenterJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, new Set(), 0));
}

function canonicalValue(value: unknown, stack: Set<object>, depth: number): unknown {
  if (depth > 32) throw invalidCommand('Command input exceeds the nesting budget.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidCommand('Command input contains a non-finite number.');
    return value;
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) throw invalidCommand('Command input contains a circular reference.');
    stack.add(value);
    try {
      return value.map((entry) => (entry === undefined ? null : canonicalValue(entry, stack, depth + 1)));
    } finally {
      stack.delete(value);
    }
  }
  if (!value || typeof value !== 'object') throw invalidCommand('Command input must contain JSON data.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidCommand('Command input must use plain JSON objects.');
  if (stack.has(value)) throw invalidCommand('Command input contains a circular reference.');
  stack.add(value);
  const result: Record<string, unknown> = {};
  try {
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      result[key] = canonicalValue(entry, stack, depth + 1);
    }
  } finally {
    stack.delete(value);
  }
  return result;
}

function readCommandCenterResult<TResult>(receipt: CommandDeliveryReceiptRecord): TResult {
  try {
    const evidence = JSON.parse(receipt.evidenceJson) as { result?: TResult | null };
    if (evidence.result === undefined || evidence.result === null) throw missingResult(receipt.commandId);
    return evidence.result;
  } catch (error) {
    if (error instanceof CommandCenterCommandApplicationError) throw error;
    throw missingResult(receipt.commandId);
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
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 512 || Array.from(value).some(isControlCharacter)) {
    throw invalidCommand(`${field} is invalid.`);
  }
  return value;
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 31 || codePoint === 127;
}

function validSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw invalidCommand(`${field} must be a lowercase SHA-256.`);
  return value;
}

function invalidCommand(message: string): CommandCenterCommandApplicationError {
  return new CommandCenterCommandApplicationError('ZEUS_COMMAND_CENTER_COMMAND_INVALID', message, 400);
}

function missingResult(commandId: string): CommandCenterCommandApplicationError {
  return new CommandCenterCommandApplicationError('ZEUS_COMMAND_CENTER_RESULT_MISSING', `Accepted Command Center command ${commandId} is missing its immutable result.`, 500);
}

export function isCommandCenterCommandError(error: unknown): error is CommandCenterCommandApplicationError | CommandEnvelopeError | CommandDeliveryStoreError {
  return (
    error instanceof CommandCenterCommandApplicationError ||
    error instanceof CommandEnvelopeError ||
    error instanceof CommandDeliveryStoreError ||
    (Boolean(error) && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && /^ZEUS_(?:COMMAND|DOMAIN)_/u.test((error as { code: string }).code))
  );
}

function isCommandDeliveryStoreError(error: unknown): error is CommandDeliveryStoreError {
  return Boolean(error) && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.startsWith('ZEUS_COMMAND_DELIVERY_');
}
