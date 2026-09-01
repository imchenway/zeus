import { createHash } from 'node:crypto';
import {
  canonicalCommandInputJson,
  CommandEnvelopeError,
  conversationDispatchWireCommandTypes,
  parseCommandEnvelope,
  type CommandEnvelope,
  type ConversationDispatchWireCommandType,
  type ConversationDispatchWirePayload,
  type ConversationDispatchWireRequest,
  type ConversationDispatchWireScopeKind,
} from '@zeus/shared';
import { ArtifactStore, CommandDeliveryRepository, CommandDeliveryStoreError, type ArtifactRef, type CommandDeliveryOutcome, type CommandDeliveryReceiptRecord, type CommandOutboxRecord, type ZeusDatabase } from '@zeus/storage';
import { createCommandValidation } from './commandApplicationPrimitives.js';

export const conversationDispatchCommandTypes = conversationDispatchWireCommandTypes;
export type ConversationDispatchCommandType = ConversationDispatchWireCommandType;
export type ConversationDispatchScopeKind = ConversationDispatchWireScopeKind;
export type ConversationDispatchCommandPayload = ConversationDispatchWirePayload;
export type ConversationDispatchMutationRequest<TInput extends object> = ConversationDispatchWireRequest<TInput>;

export interface ParsedConversationDispatchMutation<TInput extends object> {
  command: CommandEnvelope<ConversationDispatchCommandPayload>;
  input: TInput;
  inputSha256: string;
  operationIdentity: string;
}

export interface ConversationDispatchMutationResult<TResult> {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  result: TResult;
}

interface ExternalPreparation {
  state: 'prepared' | 'accepted_replay';
  parsed: ParsedConversationDispatchMutation<object>;
  outbox: CommandOutboxRecord;
  receipt?: CommandDeliveryReceiptRecord;
}

export class ConversationDispatchCommandApplicationError extends Error {
  readonly name = 'ConversationDispatchCommandApplicationError';

  constructor(
    readonly code: 'ZEUS_CONVERSATION_DISPATCH_COMMAND_INVALID' | 'ZEUS_CONVERSATION_DISPATCH_COMMAND_RESULT_MISSING' | 'ZEUS_CONVERSATION_DISPATCH_COMMAND_RESULT_TOO_LARGE' | 'ZEUS_CONVERSATION_DISPATCH_COMMAND_OUTCOME_UNKNOWN',
    message: string,
    readonly statusCode: 400 | 409 | 500,
    readonly recoveryRequired = false,
  ) {
    super(message);
  }
}

const resultArtifactGeneration = 'conversation-dispatch-command-result-v1';
const maximumExternalReplayResultBytes = 32 * 1024 * 1024;
const maximumCoreReceiptEvidenceBytes = 256 * 1024;
const maximumErrorMessageBytes = 2 * 1024;
const { requireRecord, assertExactKeys, boundedIdentity, validSha256 } = createCommandValidation(invalidCommand);

/**
 * 会话消息、队列与交互公开命令边界。
 *
 * 纯 Core 事实与 receipt 共用一次同步耐久事务。Provider、Runtime 与文件写入先形成
 * external_operation write marker；其结果只以有界 ArtifactRef 进入 receipt，写出后未知禁止自动重试。
 */
export class ConversationDispatchCommandApplication {
  private readonly activeExternalExecutions = new Map<string, Promise<ConversationDispatchMutationResult<unknown>>>();

  constructor(
    private readonly options: {
      db: ZeusDatabase;
      deliveries: CommandDeliveryRepository;
      artifacts: ArtifactStore;
      redactSensitiveText(value: string): { text: string };
      now(): Date;
    },
  ) {}

  parse<TInput extends object>(input: { value: unknown; commandType: ConversationDispatchCommandType; scopeKind: ConversationDispatchScopeKind; scopeId: string }): ParsedConversationDispatchMutation<TInput> {
    const request = requireRecord(input.value, 'Body');
    assertExactKeys(request, ['command', 'input'], input.commandType);
    const command = parseCommandEnvelope<ConversationDispatchCommandPayload>(request.command);
    if (command.commandType !== input.commandType) throw invalidCommand(`Expected commandType ${input.commandType}.`);
    if (command.scope.kind !== input.scopeKind || command.scope.id !== input.scopeId) throw invalidCommand('Command scope does not match the addressed conversation resource.');
    if (command.expectedRevision !== null) throw invalidCommand('Conversation dispatch commands require expectedRevision=null.');
    assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], input.commandType);
    const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
    const declaredInputSha256 = validSha256(command.payload.inputSha256, 'command.payload.inputSha256');
    const commandInput = requireRecord(request.input, 'Body.input') as TInput;
    const inputSha256 = conversationDispatchInputSha256(commandInput);
    if (inputSha256 !== declaredInputSha256) throw invalidCommand('Command inputSha256 does not match Body.input.');
    return { command, input: commandInput, inputSha256, operationIdentity };
  }

  executeCore<TInput extends object, TResult>(input: { parsed: ParsedConversationDispatchMutation<TInput>; destinationId: string; resourceId: string; mutateBusinessState(): TResult }): ConversationDispatchMutationResult<TResult> {
    let result: TResult | undefined;
    const evidence: CoreResultEvidence<TResult> = {
      source: 'conversation_dispatch_core',
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
        assertBoundedCoreEvidence(evidence);
      },
    });
    const resolved = delivery.created ? result : readInlineCoreResult<TResult>(delivery.receipt, input.parsed.command.commandType);
    if (resolved === undefined) throw missingResult(input.parsed.command.commandId);
    return { commandId: delivery.inbox.commandId, operationIdentity: input.parsed.operationIdentity, replayed: !delivery.created, result: resolved };
  }

  executeExternal<TInput extends object, TResult>(input: {
    parsed: ParsedConversationDispatchMutation<TInput>;
    destinationId: string;
    resourceId: string;
    /** 与现有 Provider command 或文件 journal 的稳定子操作身份；禁止每次请求随机生成。 */
    externalOperationId: string;
    beforeWrite?(): Promise<void>;
    /** Provider 派发由内部生命周期在真正写入前标记；其余外部操作仍在 invoke 前标记。 */
    manualExternalWriteStart?: boolean;
    invoke(markExternalWriteStarted: () => void): Promise<TResult>;
    mutateAcceptedBusinessState?(result: TResult): void;
    mutateFailureBusinessState?(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<ConversationDispatchMutationResult<TResult>> {
    const activeKey = [input.parsed.command.commandId, input.parsed.command.commandType, input.parsed.command.scope.kind, input.parsed.command.scope.id, input.parsed.inputSha256, input.externalOperationId].join(':');
    const active = this.activeExternalExecutions.get(activeKey);
    if (active) return active as Promise<ConversationDispatchMutationResult<TResult>>;
    const execution = this.executeExternalOnce(input).finally(() => this.activeExternalExecutions.delete(activeKey));
    this.activeExternalExecutions.set(activeKey, execution as Promise<ConversationDispatchMutationResult<unknown>>);
    return execution;
  }

  private async executeExternalOnce<TInput extends object, TResult>(input: {
    parsed: ParsedConversationDispatchMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    beforeWrite?(): Promise<void>;
    manualExternalWriteStart?: boolean;
    invoke(markExternalWriteStarted: () => void): Promise<TResult>;
    mutateAcceptedBusinessState?(result: TResult): void;
    mutateFailureBusinessState?(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<ConversationDispatchMutationResult<TResult>> {
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
        result: await this.readAcceptedExternalResult<TResult>(preparation.receipt, input.parsed.command.commandType, input.externalOperationId),
      };
    }

    let writeStarted = false;
    const markExternalWriteStarted = () => {
      if (writeStarted) return;
      this.options.deliveries.markExternalWriteStarted({ outboxId: preparation.outbox.id, occurredAt: this.options.now().toISOString() });
      writeStarted = true;
    };
    try {
      await input.beforeWrite?.();
      if (!input.manualExternalWriteStart) markExternalWriteStarted();
      const result = await input.invoke(markExternalWriteStarted);
      assertReplayableResultSize(result);
      const resultArtifact = await this.options.artifacts.putJson({
        value: result,
        owner: resultOwner(input.parsed.command.commandId),
        mimeType: 'application/vnd.zeus.conversation-dispatch-command-result+json',
        compression: 'gzip-v1',
        createdAt: this.options.now().toISOString(),
      });
      this.options.db.durableTransactionSync(() => {
        input.mutateAcceptedBusinessState?.(result);
        this.options.deliveries.recordOutcomeInCurrentTransaction({
          outboxId: preparation.outbox.id,
          outcome: 'accepted',
          evidence: acceptedExternalEvidence(preparation.parsed, input.externalOperationId, resultArtifact),
          occurredAt: this.options.now().toISOString(),
        });
      });
      return { commandId: input.parsed.command.commandId, operationIdentity: input.parsed.operationIdentity, replayed: false, result };
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
              source: 'conversation_dispatch_external',
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
        if (!isReceiptConflict(receiptError)) throw new AggregateError([error, receiptError], '会话派发外部操作与失败回执同时未能收口。');
      }
      if (outcome === 'outcome_unknown_after_write') throw outcomeUnknown(error, this.options.redactSensitiveText);
      throw error;
    }
  }

  private prepareExternal(input: { parsed: ParsedConversationDispatchMutation<object>; destinationId: string; resourceId: string; externalOperationId: string }): ExternalPreparation {
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

  private async readAcceptedExternalResult<TResult>(receipt: CommandDeliveryReceiptRecord, commandType: string, externalOperationId: string): Promise<TResult> {
    try {
      const evidence = requireRecord(JSON.parse(receipt.evidenceJson) as unknown, 'receipt.evidence');
      const artifact = requireRecord(evidence.resultArtifact, 'receipt.evidence.resultArtifact');
      if (evidence.source !== 'conversation_dispatch_external' || evidence.commandType !== commandType || evidence.externalOperationId !== externalOperationId) {
        throw new Error('Accepted conversation dispatch result identity mismatch.');
      }
      const stored = await this.options.artifacts.readAuthorized({
        sha256: validSha256(artifact.sha256, 'receipt.evidence.resultArtifact.sha256'),
        owner: { kind: 'command_delivery_result', id: receipt.commandId },
        maximumContentBytes: maximumExternalReplayResultBytes,
      });
      if (artifact.contentSha256 !== stored.ref.contentSha256 || artifact.contentByteLength !== stored.ref.contentByteLength || artifact.generationId !== resultArtifactGeneration || stored.ref.generationId !== resultArtifactGeneration) {
        throw new Error('Accepted conversation dispatch ArtifactRef does not match durable content.');
      }
      return JSON.parse(new TextDecoder().decode(stored.bytes)) as TResult;
    } catch (error) {
      if (error instanceof ConversationDispatchCommandApplicationError) throw error;
      throw missingResult(receipt.commandId);
    }
  }
}

interface CoreResultEvidence<TResult> {
  source: 'conversation_dispatch_core';
  commandType: string;
  operationIdentity: string;
  result: TResult | null;
}

export function conversationDispatchInputSha256(input: unknown): string {
  return createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex');
}

function acceptedExternalEvidence(parsed: ParsedConversationDispatchMutation<object>, externalOperationId: string, artifact: ArtifactRef): Record<string, unknown> {
  return {
    source: 'conversation_dispatch_external',
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

function readInlineCoreResult<TResult>(receipt: CommandDeliveryReceiptRecord, commandType: string): TResult {
  try {
    const evidence = JSON.parse(receipt.evidenceJson) as { source?: unknown; commandType?: unknown; result?: TResult | null };
    if (evidence.source !== 'conversation_dispatch_core' || evidence.commandType !== commandType || evidence.result === undefined || evidence.result === null) throw missingResult(receipt.commandId);
    return evidence.result;
  } catch (error) {
    if (error instanceof ConversationDispatchCommandApplicationError) throw error;
    throw missingResult(receipt.commandId);
  }
}

function assertBoundedCoreEvidence(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw resultTooLarge('Conversation dispatch Core result cannot be serialized.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumCoreReceiptEvidenceBytes) {
    throw resultTooLarge(`Conversation dispatch Core receipt exceeds ${maximumCoreReceiptEvidenceBytes} UTF-8 bytes; query the bounded projection instead.`);
  }
}

function assertReplayableResultSize(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') + 1 > maximumExternalReplayResultBytes) {
    throw resultTooLarge(`Conversation dispatch result exceeds the ${maximumExternalReplayResultBytes}-byte immutable ArtifactRef replay budget.`);
  }
}

function invalidCommand(message: string): ConversationDispatchCommandApplicationError {
  return new ConversationDispatchCommandApplicationError('ZEUS_CONVERSATION_DISPATCH_COMMAND_INVALID', message, 400);
}

function missingResult(commandId: string): ConversationDispatchCommandApplicationError {
  return new ConversationDispatchCommandApplicationError('ZEUS_CONVERSATION_DISPATCH_COMMAND_RESULT_MISSING', `Accepted conversation dispatch command ${commandId} is missing its immutable result.`, 500);
}

function resultTooLarge(message: string): ConversationDispatchCommandApplicationError {
  return new ConversationDispatchCommandApplicationError('ZEUS_CONVERSATION_DISPATCH_COMMAND_RESULT_TOO_LARGE', message, 500);
}

function isExplicitExternalRejection(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { dispatchDisposition?: unknown }).dispatchDisposition === 'runtime_rejected';
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
    const dispatchDisposition = 'dispatchDisposition' in error && typeof error.dispatchDisposition === 'string' ? boundedScalar(error.dispatchDisposition) : null;
    return { code, name: boundedScalar(error.name), message: boundedErrorMessage(error.message, redactSensitiveText), dispatchDisposition };
  }
  return { code: null, name: boundedScalar(typeof error), message: boundedErrorMessage(String(error), redactSensitiveText), dispatchDisposition: null };
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

function outcomeUnknown(cause: unknown, redactSensitiveText: (value: string) => { text: string }): ConversationDispatchCommandApplicationError {
  const detail = boundedErrorMessage(cause instanceof Error ? cause.message : String(cause), redactSensitiveText);
  return new ConversationDispatchCommandApplicationError('ZEUS_CONVERSATION_DISPATCH_COMMAND_OUTCOME_UNKNOWN', `Conversation dispatch result is unknown after the external write started: ${detail}`, 409, true);
}

export function conversationDispatchCommandHttpError(error: unknown): { statusCode: number; payload: { error: string; message: string; recoveryRequired?: true } } | null {
  if (error instanceof ConversationDispatchCommandApplicationError) {
    return { statusCode: error.statusCode, payload: { error: error.code, message: error.message, ...(error.recoveryRequired ? { recoveryRequired: true as const } : {}) } };
  }
  if (error instanceof CommandEnvelopeError) return { statusCode: 400, payload: { error: error.code, message: error.message } };
  if (!isCommandDeliveryError(error)) return null;
  const recoveryRequired = error.code === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED';
  const statusCode = error.code === 'ZEUS_COMMAND_DELIVERY_NOT_FOUND' ? 404 : error.code === 'ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT' ? 400 : error.code === 'ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT' ? 500 : 409;
  return { statusCode, payload: { error: error.code, message: error.message, ...(recoveryRequired ? { recoveryRequired: true as const } : {}) } };
}
