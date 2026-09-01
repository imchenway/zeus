import { createHash } from 'node:crypto';
import { canonicalCommandInputJson, CommandEnvelopeError, parseCommandEnvelope, type CommandEnvelope } from '@zeus/shared';
import { CommandDeliveryRepository, CommandDeliveryStoreError, type CommandDeliveryOutcome, type CommandDeliveryReceiptRecord, type CommandOutboxRecord, type ZeusDatabase } from '@zeus/storage';
import { createCommandValidation } from './commandApplicationPrimitives.js';

export const conversationCommandTypes = {
  nextTurnSettingsUpdate: 'conversation.next_turn_settings.update',
  permissionModeUpdate: 'conversation.permission_mode.update',
  collaborationModeUpdate: 'conversation.collaboration_mode.update',
  goalSet: 'conversation.goal.set',
  goalPause: 'conversation.goal.pause',
  goalResume: 'conversation.goal.resume',
  goalClear: 'conversation.goal.clear',
  attentionAcknowledge: 'conversation.attention.acknowledge',
  providerThreadRestore: 'conversation.provider_thread.restore',
  archive: 'conversation.archive',
  restore: 'conversation.restore',
} as const;

export type ConversationCommandType = (typeof conversationCommandTypes)[keyof typeof conversationCommandTypes];
export type ConversationCommandPayload = { operationIdentity: string; inputSha256: string };

export interface ConversationMutationRequest<TInput extends object> {
  command: CommandEnvelope<ConversationCommandPayload>;
  input: TInput;
}

export interface ParsedConversationMutation<TInput extends object> {
  command: CommandEnvelope<ConversationCommandPayload>;
  input: TInput;
  inputSha256: string;
  operationIdentity: string;
}

export interface ConversationMutationResult<TResult> {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  result: TResult;
}

interface PreparedConversationExternal {
  state: 'prepared';
  parsed: ParsedConversationMutation<object>;
  outbox: CommandOutboxRecord;
}

interface ReplayedConversationExternal<TResult> {
  state: 'accepted_replay';
  parsed: ParsedConversationMutation<object>;
  outbox: CommandOutboxRecord;
  result: TResult;
}

type ConversationExternalPreparation<TResult> = PreparedConversationExternal | ReplayedConversationExternal<TResult>;

export class ConversationCommandApplicationError extends Error {
  readonly name = 'ConversationCommandApplicationError';

  constructor(
    readonly code: 'ZEUS_CONVERSATION_COMMAND_INVALID' | 'ZEUS_CONVERSATION_COMMAND_RESULT_MISSING' | 'ZEUS_CONVERSATION_COMMAND_RESULT_TOO_LARGE' | 'ZEUS_CONVERSATION_COMMAND_OUTCOME_UNKNOWN',
    message: string,
    readonly statusCode: 400 | 409 | 500,
    readonly recoveryRequired = false,
  ) {
    super(message);
  }
}

const maximumReceiptEvidenceBytes = 64 * 1024;
const maximumErrorMessageBytes = 2 * 1024;
const { requireRecord, assertExactKeys, boundedIdentity, validSha256 } = createCommandValidation(invalidCommand);

/**
 * 会话配置与生命周期公开命令边界。
 *
 * 纯 Core mutation 与 accepted receipt 共用一个同步耐久事务；Provider、Runtime 或文件系统
 * 动作在调用前先写 external_operation marker，写出后的未知结果禁止自动重放。
 */
export class ConversationCommandApplication {
  private readonly activeExternalExecutions = new Map<string, Promise<ConversationMutationResult<unknown>>>();

  constructor(
    private readonly options: {
      db: ZeusDatabase;
      deliveries: CommandDeliveryRepository;
      redactSensitiveText(value: string): { text: string };
      now(): Date;
    },
  ) {}

  parse<TInput extends object>(input: { value: unknown; commandType: ConversationCommandType; conversationId: string }): ParsedConversationMutation<TInput> {
    const request = requireRecord(input.value, 'Body');
    assertExactKeys(request, ['command', 'input'], input.commandType);
    const command = parseCommandEnvelope<ConversationCommandPayload>(request.command);
    if (command.commandType !== input.commandType) throw invalidCommand(`Expected commandType ${input.commandType}.`);
    if (command.scope.kind !== 'product_conversation' || command.scope.id !== input.conversationId) {
      throw invalidCommand('Command scope does not match the addressed conversation.');
    }
    assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], input.commandType);
    const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
    const declaredInputSha256 = validSha256(command.payload.inputSha256, 'command.payload.inputSha256');
    const commandInput = requireRecord(request.input, 'Body.input') as TInput;
    const inputSha256 = conversationInputSha256(commandInput);
    if (inputSha256 !== declaredInputSha256) throw invalidCommand('Command inputSha256 does not match Body.input.');
    return { command, input: commandInput, inputSha256, operationIdentity };
  }

  executeCore<TInput extends object, TResult>(input: { parsed: ParsedConversationMutation<TInput>; destinationId: string; resourceId: string; mutateBusinessState(): TResult }): ConversationMutationResult<TResult> {
    let result: TResult | undefined;
    const evidence: ConversationResultEvidence<TResult> = {
      source: 'conversation_command_application',
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
        assertBoundedReceiptEvidence(evidence);
      },
    });
    const resolved = delivery.created ? result : readConversationResult<TResult>(delivery.receipt, input.parsed.command.commandType);
    if (resolved === undefined) throw missingResult(input.parsed.command.commandId);
    return {
      commandId: delivery.inbox.commandId,
      operationIdentity: input.parsed.operationIdentity,
      replayed: !delivery.created,
      result: resolved,
    };
  }

  executeExternal<TInput extends object, TResult>(input: {
    parsed: ParsedConversationMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId?: string;
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState?(result: TResult): void;
    mutateFailureBusinessState?(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<ConversationMutationResult<TResult>> {
    const activeKey = `${input.parsed.command.commandId}:${input.parsed.inputSha256}`;
    const active = this.activeExternalExecutions.get(activeKey);
    if (active) return active as Promise<ConversationMutationResult<TResult>>;
    const execution = this.executeExternalOnce(input).finally(() => this.activeExternalExecutions.delete(activeKey));
    this.activeExternalExecutions.set(activeKey, execution as Promise<ConversationMutationResult<unknown>>);
    return execution;
  }

  private async executeExternalOnce<TInput extends object, TResult>(input: {
    parsed: ParsedConversationMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId?: string;
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState?(result: TResult): void;
    mutateFailureBusinessState?(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<ConversationMutationResult<TResult>> {
    const preparation = this.prepareExternal<TResult>({
      parsed: input.parsed,
      destinationId: input.destinationId,
      resourceId: input.resourceId,
      externalOperationId: input.externalOperationId ?? input.parsed.operationIdentity,
    });
    if (preparation.state === 'accepted_replay') {
      return {
        commandId: preparation.outbox.commandId,
        operationIdentity: input.parsed.operationIdentity,
        replayed: true,
        result: preparation.result,
      };
    }

    let writeStarted = false;
    try {
      await input.beforeWrite?.();
      this.options.deliveries.markExternalWriteStarted({ outboxId: preparation.outbox.id, occurredAt: this.options.now().toISOString() });
      writeStarted = true;
      const result = await input.invoke();
      const evidence = externalEvidence(preparation.parsed, preparation.outbox.externalOperationId, result);
      assertBoundedReceiptEvidence(evidence);
      this.options.db.durableTransactionSync(() => {
        input.mutateAcceptedBusinessState?.(result);
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
      const explicitlyRejected = writeStarted && (input.isExplicitRejection?.(error) ?? isExplicitExternalRejection(error));
      const outcome: Exclude<CommandDeliveryOutcome, 'accepted'> = explicitlyRejected ? 'explicitly_rejected' : writeStarted ? 'outcome_unknown_after_write' : 'failed_before_write';
      try {
        this.options.db.durableTransactionSync(() => {
          input.mutateFailureBusinessState?.(outcome, error);
          this.options.deliveries.recordOutcomeInCurrentTransaction({
            outboxId: preparation.outbox.id,
            outcome,
            evidence: {
              source: 'conversation_external_operation',
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
        if (!isReceiptConflict(receiptError)) throw new AggregateError([error, receiptError], '会话外部操作与失败回执同时未能收口。');
      }
      if (outcome === 'outcome_unknown_after_write') throw outcomeUnknown(error, this.options.redactSensitiveText);
      throw error;
    }
  }

  private prepareExternal<TResult>(input: { parsed: ParsedConversationMutation<object>; destinationId: string; resourceId: string; externalOperationId: string }): ConversationExternalPreparation<TResult> {
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
      if (!isCommandDeliveryError(error) || error.code !== 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED') throw error;
      const latest = this.options.deliveries.get(input.parsed.command.commandId)?.attempts.at(-1);
      if (!latest?.receipt || latest.outcome !== 'accepted') throw error;
      return {
        state: 'accepted_replay',
        parsed: input.parsed,
        outbox: latest,
        result: readConversationResult<TResult>(latest.receipt, input.parsed.command.commandType),
      };
    }
  }
}

interface ConversationResultEvidence<TResult> {
  source: 'conversation_command_application';
  commandType: string;
  operationIdentity: string;
  result: TResult | null;
}

export function conversationInputSha256(input: unknown): string {
  return createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex');
}

function externalEvidence<TResult>(parsed: ParsedConversationMutation<object>, externalOperationId: string | null, result: TResult): Record<string, unknown> {
  return {
    source: 'conversation_external_operation',
    commandType: parsed.command.commandType,
    operationIdentity: parsed.operationIdentity,
    externalOperationId,
    result,
  };
}

function readConversationResult<TResult>(receipt: CommandDeliveryReceiptRecord, commandType: string): TResult {
  try {
    const evidence = JSON.parse(receipt.evidenceJson) as { source?: unknown; commandType?: unknown; result?: TResult | null };
    if ((evidence.source !== 'conversation_command_application' && evidence.source !== 'conversation_external_operation') || evidence.commandType !== commandType || evidence.result === undefined || evidence.result === null) {
      throw missingResult(receipt.commandId);
    }
    return evidence.result;
  } catch (error) {
    if (error instanceof ConversationCommandApplicationError) throw error;
    throw missingResult(receipt.commandId);
  }
}

function invalidCommand(message: string): ConversationCommandApplicationError {
  return new ConversationCommandApplicationError('ZEUS_CONVERSATION_COMMAND_INVALID', message, 400);
}

function missingResult(commandId: string): ConversationCommandApplicationError {
  return new ConversationCommandApplicationError('ZEUS_CONVERSATION_COMMAND_RESULT_MISSING', `Accepted conversation command ${commandId} is missing its immutable result.`, 500);
}

function isExplicitExternalRejection(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { dispatchDisposition?: unknown }).dispatchDisposition === 'runtime_rejected';
}

function isReceiptConflict(error: unknown): boolean {
  return isCommandDeliveryError(error) && error.code === 'ZEUS_COMMAND_DELIVERY_RECEIPT_CONFLICT';
}

function isCommandDeliveryError(error: unknown): error is CommandDeliveryStoreError {
  return Boolean(error) && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.startsWith('ZEUS_COMMAND_DELIVERY_');
}

function serializeError(error: unknown, redactSensitiveText: (value: string) => { text: string }): Record<string, unknown> {
  if (error instanceof Error) {
    const code = 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? boundedScalar(error.code) : null;
    const dispatchDisposition = 'dispatchDisposition' in error && typeof error.dispatchDisposition === 'string' ? boundedScalar(error.dispatchDisposition) : null;
    return { code, name: boundedScalar(error.name), message: boundedErrorMessage(error.message, redactSensitiveText), dispatchDisposition };
  }
  return { code: null, name: boundedScalar(typeof error), message: boundedErrorMessage(String(error), redactSensitiveText), dispatchDisposition: null };
}

function assertBoundedReceiptEvidence(value: unknown): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ConversationCommandApplicationError('ZEUS_CONVERSATION_COMMAND_RESULT_TOO_LARGE', 'Conversation command result cannot be serialized into a durable receipt.', 500);
  }
  if (Buffer.byteLength(encoded, 'utf8') > maximumReceiptEvidenceBytes) {
    throw new ConversationCommandApplicationError('ZEUS_CONVERSATION_COMMAND_RESULT_TOO_LARGE', `Conversation command receipt exceeds the ${maximumReceiptEvidenceBytes}-byte UTF-8 limit; large results require an ArtifactRef.`, 500);
  }
}

function outcomeUnknown(cause: unknown, redactSensitiveText: (value: string) => { text: string }): ConversationCommandApplicationError {
  const detail = boundedErrorMessage(cause instanceof Error ? cause.message : String(cause), redactSensitiveText);
  return new ConversationCommandApplicationError('ZEUS_CONVERSATION_COMMAND_OUTCOME_UNKNOWN', `Conversation command result is unknown after the external write started: ${detail}`, 409, true);
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

export function conversationCommandHttpError(error: unknown): { statusCode: number; payload: { error: string; message: string; recoveryRequired?: true } } | null {
  if (error instanceof ConversationCommandApplicationError) {
    return { statusCode: error.statusCode, payload: { error: error.code, message: error.message, ...(error.recoveryRequired ? { recoveryRequired: true as const } : {}) } };
  }
  if (error instanceof CommandEnvelopeError) return { statusCode: 400, payload: { error: error.code, message: error.message } };
  if (!isCommandDeliveryError(error)) return null;
  const recoveryRequired = error.code === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED';
  const statusCode = error.code === 'ZEUS_COMMAND_DELIVERY_NOT_FOUND' ? 404 : error.code === 'ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT' ? 400 : error.code === 'ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT' ? 500 : 409;
  return {
    statusCode,
    payload: {
      error: error.code,
      message: error.message,
      ...(recoveryRequired ? { recoveryRequired: true as const } : {}),
    },
  };
}
