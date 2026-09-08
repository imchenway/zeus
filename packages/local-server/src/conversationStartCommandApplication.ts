import { userFacingErrorCause, type UserFacingErrorCause } from '@zeus/shared';
import { createHash } from 'node:crypto';
import { canonicalCommandInputJson, type CommandEnvelope, CommandEnvelopeError, type CommandScopeKind, parseCommandEnvelope } from '@zeus/shared';
import { type ArtifactRef, ArtifactStore, type CommandDeliveryOutcome, type CommandDeliveryReceiptRecord, CommandDeliveryRepository, CommandDeliveryStoreError, type CommandOutboxRecord, type ZeusDatabase } from '@zeus/storage';
import { createCommandValidation } from './commandApplicationPrimitives.js';

/** 项目与任务会话首发的稳定命令名称。 */
export const conversationStartCommandTypes = {
  projectConversationCreate: 'conversation.project.create',
  taskConversationCreate: 'conversation.task.create',
} as const;

/** 会话首发的数据约束。 */
export type ConversationStartCommandType = (typeof conversationStartCommandTypes)[keyof typeof conversationStartCommandTypes];
/** 会话首发的数据约束。 */
export type ConversationStartCommandScopeKind = Extract<CommandScopeKind, 'project' | 'task'>;
/** 会话首发的数据约束。 */
export type ConversationStartCommandPayload = { operationIdentity: string; inputSha256: string };

/** 会话首发的数据约束。 */
export interface ConversationStartMutationRequest<TInput extends object> {
  command: CommandEnvelope<ConversationStartCommandPayload>;
  input: TInput;
}

/** 会话首发的数据约束。 */
export interface ParsedConversationStartMutation<TInput extends object> {
  command: CommandEnvelope<ConversationStartCommandPayload>;
  input: TInput;
  inputSha256: string;
  operationIdentity: string;
}

/** 会话首发的数据约束。 */
export interface ConversationStartMutationResult<TResult> {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  result: TResult;
}

/** 会话首发的数据约束。 */
interface ExternalPreparation {
  state: 'prepared' | 'accepted_replay';
  parsed: ParsedConversationStartMutation<object>;
  outbox: CommandOutboxRecord;
  receipt?: CommandDeliveryReceiptRecord;
}

/** 会话首发错误类型，保留原因与恢复限制。 */
export class ConversationStartCommandApplicationError extends Error {
  readonly name = 'ConversationStartCommandApplicationError';

  constructor(
    readonly code: 'ZEUS_CONVERSATION_START_COMMAND_INVALID' | 'ZEUS_CONVERSATION_START_COMMAND_RESULT_MISSING' | 'ZEUS_CONVERSATION_START_COMMAND_RESULT_TOO_LARGE' | 'ZEUS_CONVERSATION_START_COMMAND_OUTCOME_UNKNOWN',
    message: string,
    readonly statusCode: 400 | 409 | 500,
    readonly recoveryRequired = false,
    /** 保留底层错误原因，不改变原有操作结果和恢复限制。 */
    override readonly cause?: UserFacingErrorCause,
  ) {
    super(message);
  }
}

/** 历史首发回执的持久代次不能改名，否则成功操作无法安全重放。 */
const resultArtifactGeneration = 'graph-conversation-command-result-v1';
/** 成功回执文件允许的最大正文大小。 */
const maximumReplayResultBytes = 32 * 1024 * 1024;
/** 错误证据脱敏后允许的最大字节数。 */
const maximumErrorMessageBytes = 2 * 1024;
const { requireRecord, assertExactKeys, boundedIdentity, validSha256 } = createCommandValidation(invalidCommand);

/**
 * 项目与任务会话首发的公开命令边界。
 * Provider 写入前先记录标记；成功回执只保存结果文件引用，
 * 写出后的不确定结果禁止自动重发。
 */
export class ConversationStartCommandApplication {
  private readonly activeExternalExecutions = new Map<string, Promise<ConversationStartMutationResult<unknown>>>();

  constructor(
    private readonly options: {
      db: ZeusDatabase;
      deliveries: CommandDeliveryRepository;
      artifacts: ArtifactStore;
      redactSensitiveText(value: string): { text: string };
      now(): Date;
    },
  ) {}

  /** 检查请求身份、目标与正文摘要是否一致。 */
  parse<TInput extends object>(input: { value: unknown; commandType: ConversationStartCommandType; scopeKind: ConversationStartCommandScopeKind; scopeId: string }): ParsedConversationStartMutation<TInput> {
    const request = requireRecord(input.value, 'Body');
    assertExactKeys(request, ['command', 'input'], input.commandType);
    const command = parseCommandEnvelope<ConversationStartCommandPayload>(request.command);
    if (command.commandType !== input.commandType) throw invalidCommand(`Expected commandType ${input.commandType}.`);
    if (command.scope.kind !== input.scopeKind || command.scope.id !== input.scopeId) {
      throw invalidCommand('Command scope does not match the addressed conversation resource.');
    }
    if (command.expectedRevision !== null) throw invalidCommand('Conversation-create commands require expectedRevision=null.');
    assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], input.commandType);
    const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
    const declaredInputSha256 = validSha256(command.payload.inputSha256, 'command.payload.inputSha256');
    const commandInput = requireRecord(request.input, 'Body.input') as TInput;
    const inputSha256 = conversationStartInputSha256(commandInput);
    if (inputSha256 !== declaredInputSha256) throw invalidCommand('Command inputSha256 does not match Body.input.');
    return { command, input: commandInput, inputSha256, operationIdentity };
  }

  /** 合并并发首发请求并复用已完成回执。 */
  executeExternal<TInput extends object, TResult>(input: {
    parsed: ParsedConversationStartMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    beforeWrite?(): Promise<void>;
    invoke(markExternalWriteStarted: () => void): Promise<TResult>;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<ConversationStartMutationResult<TResult>> {
    const activeKey = [input.parsed.command.commandId, input.parsed.command.commandType, input.parsed.command.scope.kind, input.parsed.command.scope.id, input.parsed.inputSha256, input.externalOperationId].join(':');
    const active = this.activeExternalExecutions.get(activeKey);
    if (active) return active as Promise<ConversationStartMutationResult<TResult>>;
    const execution = this.executeExternalOnce(input).finally(() => this.activeExternalExecutions.delete(activeKey));
    this.activeExternalExecutions.set(activeKey, execution as Promise<ConversationStartMutationResult<unknown>>);
    return execution;
  }

  /** 执行一次首发并持久记录写入前后状态。 */
  private async executeExternalOnce<TInput extends object, TResult>(input: {
    parsed: ParsedConversationStartMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    beforeWrite?(): Promise<void>;
    invoke(markExternalWriteStarted: () => void): Promise<TResult>;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<ConversationStartMutationResult<TResult>> {
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
        if (!isReceiptConflict(receiptError)) throw new AggregateError([error, receiptError], '会话首发 外部操作与失败回执同时未能收口。');
      }
      if (outcome === 'outcome_unknown_after_write') throw outcomeUnknown(error, this.options.redactSensitiveText);
      throw error;
    }
  }

  /** 登记首发意图或读取已经完成的回执。 */
  private prepareExternal(input: { parsed: ParsedConversationStartMutation<object>; destinationId: string; resourceId: string; externalOperationId: string }): ExternalPreparation {
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

  /** 校验持久回执并读取原始接受结果。 */
  private async readAcceptedResult<TResult>(receipt: CommandDeliveryReceiptRecord, commandType: string, externalOperationId: string): Promise<TResult> {
    try {
      const evidence = requireRecord(JSON.parse(receipt.evidenceJson) as unknown, 'receipt.evidence');
      const artifact = requireRecord(evidence.resultArtifact, 'receipt.evidence.resultArtifact');
      if (evidence.source !== 'graph_conversation_external_operation' || evidence.commandType !== commandType || evidence.externalOperationId !== externalOperationId) {
        throw new Error('Accepted 会话首发 result identity mismatch.');
      }
      const stored = await this.options.artifacts.readAuthorized({
        sha256: validSha256(artifact.sha256, 'receipt.evidence.resultArtifact.sha256'),
        owner: { kind: 'command_delivery_result', id: receipt.commandId },
        maximumContentBytes: maximumReplayResultBytes,
      });
      if (artifact.contentSha256 !== stored.ref.contentSha256 || artifact.contentByteLength !== stored.ref.contentByteLength || artifact.generationId !== resultArtifactGeneration || stored.ref.generationId !== resultArtifactGeneration) {
        throw new Error('Accepted 会话首发 ArtifactRef does not match durable content.');
      }
      return JSON.parse(new TextDecoder().decode(stored.bytes)) as TResult;
    } catch (error) {
      if (error instanceof ConversationStartCommandApplicationError) throw error;
      throw missingResult(receipt.commandId);
    }
  }
}

/** 计算首发正文的稳定摘要。 */
export function conversationStartInputSha256(input: unknown): string {
  return createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex');
}

/** 只在回执中记录有界结果文件引用。 */
function acceptedEvidence(parsed: ParsedConversationStartMutation<object>, externalOperationId: string, artifact: ArtifactRef): Record<string, unknown> {
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

/** 将结果文件绑定到原始首发命令。 */
function resultOwner(commandId: string) {
  return { kind: 'command_delivery_result', id: commandId, generationId: resultArtifactGeneration } as const;
}

/** 拒绝无法安全持久重放的超大结果。 */
function assertReplayableResultSize(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') + 1 > maximumReplayResultBytes) {
    throw new ConversationStartCommandApplicationError('ZEUS_CONVERSATION_START_COMMAND_RESULT_TOO_LARGE', `会话首发结果超过允许持久保存的 ${maximumReplayResultBytes} 字节上限。`, 500);
  }
}

/** 构造会话首发输入错误。 */
function invalidCommand(message: string): ConversationStartCommandApplicationError {
  return new ConversationStartCommandApplicationError('ZEUS_CONVERSATION_START_COMMAND_INVALID', message, 400);
}

/** 标明已接受操作缺少持久结果，禁止重复发送。 */
function missingResult(commandId: string): ConversationStartCommandApplicationError {
  return new ConversationStartCommandApplicationError('ZEUS_CONVERSATION_START_COMMAND_RESULT_MISSING', `已接受的会话首发命令 ${commandId} 缺少持久结果。`, 500);
}

/** 识别命令回执仓库的错误。 */
function isCommandDeliveryError(error: unknown): error is CommandDeliveryStoreError {
  return Boolean(error) && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.startsWith('ZEUS_COMMAND_DELIVERY_');
}

/** 识别不可变回执之间的冲突。 */
function isReceiptConflict(error: unknown): boolean {
  return isCommandDeliveryError(error) && error.code === 'ZEUS_COMMAND_DELIVERY_RECEIPT_CONFLICT';
}

/** 脱敏并限制首发失败证据大小。 */
function serializeError(error: unknown, redactSensitiveText: (value: string) => { text: string }): Record<string, unknown> {
  if (error instanceof Error) {
    const code = 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? boundedScalar(error.code) : null;
    return { cause: userFacingErrorCause(error).cause, code, name: boundedScalar(error.name), message: boundedErrorMessage(error.message, redactSensitiveText) };
  }
  return { code: null, name: boundedScalar(typeof error), message: boundedErrorMessage(String(error), redactSensitiveText) };
}

/** 按字节限制脱敏后的错误详情。 */
function boundedErrorMessage(value: string, redactSensitiveText: (value: string) => { text: string }): string {
  const redacted = redactSensitiveText(value).text;
  const bytes = Buffer.from(redacted, 'utf8');
  if (bytes.byteLength <= maximumErrorMessageBytes) return redacted;
  return `${bytes
    .subarray(0, maximumErrorMessageBytes - 3)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')}...`;
}

/** 限制错误标量大小。 */
function boundedScalar(value: string | number): string | number {
  return typeof value === 'number' ? value : value.slice(0, 128);
}

/** 将已写出但结果未知的操作标记为待恢复。 */
function outcomeUnknown(cause: unknown, redactSensitiveText: (value: string) => { text: string }): ConversationStartCommandApplicationError {
  const detail = boundedErrorMessage(cause instanceof Error ? cause.message : String(cause), redactSensitiveText);
  return new ConversationStartCommandApplicationError('ZEUS_CONVERSATION_START_COMMAND_OUTCOME_UNKNOWN', `会话首发已开始写入，但结果未知：${detail}`, 409, true, userFacingErrorCause(cause));
}

/** 将首发错误映射为用户可见响应和恢复限制。 */
export function conversationStartCommandHttpError(error: unknown): { statusCode: number; payload: { error: string; message: string; recoveryRequired?: true; cause?: UserFacingErrorCause } } | null {
  if (error instanceof ConversationStartCommandApplicationError) {
    return {
      statusCode: error.statusCode,
      payload: { error: error.code, message: error.message, cause: error.cause, ...(error.recoveryRequired ? { recoveryRequired: true as const } : {}) },
    };
  }
  if (error instanceof CommandEnvelopeError) return { statusCode: 400, payload: { error: error.code, message: error.message } };
  if (!isCommandDeliveryError(error)) return null;
  const recoveryRequired = error.code === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED';
  const statusCode = error.code === 'ZEUS_COMMAND_DELIVERY_NOT_FOUND' ? 404 : error.code === 'ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT' ? 400 : error.code === 'ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT' ? 500 : 409;
  return { statusCode, payload: { error: error.code, message: error.message, cause: userFacingErrorCause(error).cause, ...(recoveryRequired ? { recoveryRequired: true as const } : {}) } };
}
