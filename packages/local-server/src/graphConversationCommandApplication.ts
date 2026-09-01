import { createHash } from 'node:crypto';
import { canonicalCommandInputJson, type CommandEnvelope, CommandEnvelopeError, type CommandScopeKind, parseCommandEnvelope } from '@zeus/shared';
import { type ArtifactRef, ArtifactStore, type CommandDeliveryOutcome, type CommandDeliveryReceiptRecord, CommandDeliveryRepository, CommandDeliveryStoreError, type CommandOutboxRecord, type ZeusDatabase } from '@zeus/storage';
import { createCommandValidation } from './commandApplicationPrimitives.js';

export const graphConversationCommandTypes = {
  projectConversationCreate: 'conversation.project.create',
  taskConversationCreate: 'conversation.task.create',
  projectGraphScan: 'graph.project.scan',
  projectGraphViewsGenerate: 'graph.project.views.generate',
  projectGraphAsk: 'graph.project.ask',
  currentGraphScan: 'graph.current.scan',
} as const;

export type GraphConversationCommandType = (typeof graphConversationCommandTypes)[keyof typeof graphConversationCommandTypes];
export type GraphConversationCommandScopeKind = Extract<CommandScopeKind, 'project' | 'task'>;
export type GraphConversationCommandPayload = { operationIdentity: string; inputSha256: string };

export interface GraphConversationMutationRequest<TInput extends object> {
  command: CommandEnvelope<GraphConversationCommandPayload>;
  input: TInput;
}

export interface ParsedGraphConversationMutation<TInput extends object> {
  command: CommandEnvelope<GraphConversationCommandPayload>;
  input: TInput;
  inputSha256: string;
  operationIdentity: string;
}

export interface GraphConversationMutationResult<TResult> {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  result: TResult;
}

interface ExternalPreparation {
  state: 'prepared' | 'accepted_replay';
  parsed: ParsedGraphConversationMutation<object>;
  outbox: CommandOutboxRecord;
  receipt?: CommandDeliveryReceiptRecord;
}

export class GraphConversationCommandApplicationError extends Error {
  readonly name = 'GraphConversationCommandApplicationError';

  constructor(
    readonly code: 'ZEUS_GRAPH_CONVERSATION_COMMAND_INVALID' | 'ZEUS_GRAPH_CONVERSATION_COMMAND_RESULT_MISSING' | 'ZEUS_GRAPH_CONVERSATION_COMMAND_RESULT_TOO_LARGE' | 'ZEUS_GRAPH_CONVERSATION_COMMAND_OUTCOME_UNKNOWN',
    message: string,
    readonly statusCode: 400 | 409 | 500,
    readonly recoveryRequired = false,
  ) {
    super(message);
  }
}

const resultArtifactGeneration = 'graph-conversation-command-result-v1';
const maximumReplayResultBytes = 32 * 1024 * 1024;
const maximumErrorMessageBytes = 2 * 1024;
const { requireRecord, assertExactKeys, boundedIdentity, validSha256 } = createCommandValidation(invalidCommand);

/**
 * 会话首发、图扫描与图谱问答的公开 External Command 边界。
 * Provider、进程、Worker、文件或投影写入前先落 write marker；accepted 只保存 ArtifactRef，
 * 写出后的不确定结果禁止自动重发。
 */
export class GraphConversationCommandApplication {
  private readonly activeExternalExecutions = new Map<string, Promise<GraphConversationMutationResult<unknown>>>();

  constructor(
    private readonly options: {
      db: ZeusDatabase;
      deliveries: CommandDeliveryRepository;
      artifacts: ArtifactStore;
      redactSensitiveText(value: string): { text: string };
      now(): Date;
    },
  ) {}

  parse<TInput extends object>(input: { value: unknown; commandType: GraphConversationCommandType; scopeKind: GraphConversationCommandScopeKind; scopeId: string }): ParsedGraphConversationMutation<TInput> {
    const request = requireRecord(input.value, 'Body');
    assertExactKeys(request, ['command', 'input'], input.commandType);
    const command = parseCommandEnvelope<GraphConversationCommandPayload>(request.command);
    if (command.commandType !== input.commandType) throw invalidCommand(`Expected commandType ${input.commandType}.`);
    if (command.scope.kind !== input.scopeKind || command.scope.id !== input.scopeId) {
      throw invalidCommand('Command scope does not match the addressed conversation or graph resource.');
    }
    if (command.expectedRevision !== null) throw invalidCommand('Graph and conversation-create commands require expectedRevision=null.');
    assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], input.commandType);
    const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
    const declaredInputSha256 = validSha256(command.payload.inputSha256, 'command.payload.inputSha256');
    const commandInput = requireRecord(request.input, 'Body.input') as TInput;
    const inputSha256 = graphConversationInputSha256(commandInput);
    if (inputSha256 !== declaredInputSha256) throw invalidCommand('Command inputSha256 does not match Body.input.');
    return { command, input: commandInput, inputSha256, operationIdentity };
  }

  executeExternal<TInput extends object, TResult>(input: {
    parsed: ParsedGraphConversationMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    beforeWrite?(): Promise<void>;
    /** 会话首发由内部 Provider 生命周期精确标记；其他外部操作仍在 invoke 前标记。 */
    manualExternalWriteStart?: boolean;
    invoke(markExternalWriteStarted: () => void): Promise<TResult>;
    mutateAcceptedBusinessState?(result: TResult): void;
    mutateFailureBusinessState?(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<GraphConversationMutationResult<TResult>> {
    const activeKey = [input.parsed.command.commandId, input.parsed.command.commandType, input.parsed.command.scope.kind, input.parsed.command.scope.id, input.parsed.inputSha256, input.externalOperationId].join(':');
    const active = this.activeExternalExecutions.get(activeKey);
    if (active) return active as Promise<GraphConversationMutationResult<TResult>>;
    const execution = this.executeExternalOnce(input).finally(() => this.activeExternalExecutions.delete(activeKey));
    this.activeExternalExecutions.set(activeKey, execution as Promise<GraphConversationMutationResult<unknown>>);
    return execution;
  }

  private async executeExternalOnce<TInput extends object, TResult>(input: {
    parsed: ParsedGraphConversationMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    beforeWrite?(): Promise<void>;
    manualExternalWriteStart?: boolean;
    invoke(markExternalWriteStarted: () => void): Promise<TResult>;
    mutateAcceptedBusinessState?(result: TResult): void;
    mutateFailureBusinessState?(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<GraphConversationMutationResult<TResult>> {
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
    const markExternalWriteStarted = (): void => {
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
        mimeType: 'application/vnd.zeus.graph-conversation-command-result+json',
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
              source: 'graph_conversation_external_operation',
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
        if (!isReceiptConflict(receiptError)) throw new AggregateError([error, receiptError], 'Graph/Conversation 外部操作与失败回执同时未能收口。');
      }
      if (outcome === 'outcome_unknown_after_write') throw outcomeUnknown(error, this.options.redactSensitiveText);
      throw error;
    }
  }

  private prepareExternal(input: { parsed: ParsedGraphConversationMutation<object>; destinationId: string; resourceId: string; externalOperationId: string }): ExternalPreparation {
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
      if (evidence.source !== 'graph_conversation_external_operation' || evidence.commandType !== commandType || evidence.externalOperationId !== externalOperationId) {
        throw new Error('Accepted Graph/Conversation result identity mismatch.');
      }
      const stored = await this.options.artifacts.readAuthorized({
        sha256: validSha256(artifact.sha256, 'receipt.evidence.resultArtifact.sha256'),
        owner: { kind: 'command_delivery_result', id: receipt.commandId },
        maximumContentBytes: maximumReplayResultBytes,
      });
      if (artifact.contentSha256 !== stored.ref.contentSha256 || artifact.contentByteLength !== stored.ref.contentByteLength || artifact.generationId !== resultArtifactGeneration || stored.ref.generationId !== resultArtifactGeneration) {
        throw new Error('Accepted Graph/Conversation ArtifactRef does not match durable content.');
      }
      return JSON.parse(new TextDecoder().decode(stored.bytes)) as TResult;
    } catch (error) {
      if (error instanceof GraphConversationCommandApplicationError) throw error;
      throw missingResult(receipt.commandId);
    }
  }
}

export function graphConversationInputSha256(input: unknown): string {
  return createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex');
}

function acceptedEvidence(parsed: ParsedGraphConversationMutation<object>, externalOperationId: string, artifact: ArtifactRef): Record<string, unknown> {
  return {
    source: 'graph_conversation_external_operation',
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
    throw new GraphConversationCommandApplicationError('ZEUS_GRAPH_CONVERSATION_COMMAND_RESULT_TOO_LARGE', `Graph/Conversation result exceeds the ${maximumReplayResultBytes}-byte immutable ArtifactRef replay budget.`, 500);
  }
}

function invalidCommand(message: string): GraphConversationCommandApplicationError {
  return new GraphConversationCommandApplicationError('ZEUS_GRAPH_CONVERSATION_COMMAND_INVALID', message, 400);
}

function missingResult(commandId: string): GraphConversationCommandApplicationError {
  return new GraphConversationCommandApplicationError('ZEUS_GRAPH_CONVERSATION_COMMAND_RESULT_MISSING', `Accepted Graph/Conversation command ${commandId} is missing its immutable result.`, 500);
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

function outcomeUnknown(cause: unknown, redactSensitiveText: (value: string) => { text: string }): GraphConversationCommandApplicationError {
  const detail = boundedErrorMessage(cause instanceof Error ? cause.message : String(cause), redactSensitiveText);
  return new GraphConversationCommandApplicationError('ZEUS_GRAPH_CONVERSATION_COMMAND_OUTCOME_UNKNOWN', `Graph/Conversation result is unknown after the external write started: ${detail}`, 409, true);
}

export function graphConversationCommandHttpError(error: unknown): { statusCode: number; payload: { error: string; message: string; recoveryRequired?: true } } | null {
  if (error instanceof GraphConversationCommandApplicationError) {
    return {
      statusCode: error.statusCode,
      payload: { error: error.code, message: error.message, ...(error.recoveryRequired ? { recoveryRequired: true as const } : {}) },
    };
  }
  if (error instanceof CommandEnvelopeError) return { statusCode: 400, payload: { error: error.code, message: error.message } };
  if (!isCommandDeliveryError(error)) return null;
  const recoveryRequired = error.code === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED';
  const statusCode = error.code === 'ZEUS_COMMAND_DELIVERY_NOT_FOUND' ? 404 : error.code === 'ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT' ? 400 : error.code === 'ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT' ? 500 : 409;
  return { statusCode, payload: { error: error.code, message: error.message, ...(recoveryRequired ? { recoveryRequired: true as const } : {}) } };
}
