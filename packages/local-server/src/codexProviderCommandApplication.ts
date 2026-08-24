import { createHash } from 'node:crypto';
import { commandEnvelopeSchemaGeneration, parseCommandEnvelope, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { currentDatabasePerformanceTraceId, type CommandDeliveryReceiptRecord, type CommandDeliveryRepository, type ZeusDatabase } from '@zeus/storage';

export type CodexProviderCommandOperation = 'thread_start' | 'thread_archive' | 'thread_unarchive' | 'turn_start' | 'turn_steer' | 'turn_interrupt' | 'goal_set' | 'goal_clear' | 'server_request_response';

interface ExecuteCodexProviderCommandBase<T> {
  operation: CodexProviderCommandOperation;
  commandKey: string;
  scope: { kind: CommandScopeKind; id: string };
  idempotencyKey: string;
  issuedAt: string;
  resourceId: string;
  requestIdentity: unknown;
  providerGenerationId: string | null;
  acceptedProviderGenerationId?(result: T): string | null;
  traceIdentity?: string | null;
  invoke(traceIdentity: string | null): Promise<T>;
  isExplicitRejection?(error: unknown): boolean;
  mutateBusinessState?(result: T): void;
}

export interface ExecuteCodexSessionCommandInput<T> extends ExecuteCodexProviderCommandBase<T> {
  nativeSessionId(result: T): string;
  /**
   * 子命令已经被 Provider 接纳、但父业务投影尚未来得及提交时，只允许按回执中的真实 session 身份做只读恢复。
   * 不提供恢复器的调用仍保持 fail-closed，绝不重新写出。
   */
  recoverAccepted?(nativeSessionId: string, receipt: CommandDeliveryReceiptRecord): Promise<T>;
}

export interface ExecuteCodexTurnCommandInput<T> extends ExecuteCodexProviderCommandBase<T> {
  nativeSessionId: string;
  nativeTurnId(result: T): string;
}

interface CodexProviderCommandPayload extends Record<string, unknown> {
  provider: 'codex';
  operation: CodexProviderCommandOperation;
  resourceId: string;
  requestSha256: string;
}

/** Codex thread/session 与 turn 写操作的统一 prepare → write marker → 四态回执边界。 */
export class CodexProviderCommandApplicationService {
  constructor(
    private readonly db: ZeusDatabase,
    private readonly commandDeliveries: CommandDeliveryRepository,
    private readonly now: () => string,
  ) {}

  async executeSession<T>(input: ExecuteCodexSessionCommandInput<T>): Promise<T> {
    const attempt = this.prepare(input, 'provider_session');
    if (attempt.state === 'accepted_replay') {
      const nativeSessionId = requiredIdentity(attempt.receipt.nativeSessionId, 'nativeSessionId');
      if (!input.recoverAccepted) throw commandError('ZEUS_CODEX_PROVIDER_ACCEPTED_RECOVERY_REQUIRED', 'Codex Provider 子命令已接纳，但调用方没有提供只读恢复路径。');
      return input.recoverAccepted(nativeSessionId, attempt.receipt);
    }
    let writeStarted = false;
    try {
      this.commandDeliveries.markProviderWriteStarted({ outboxId: attempt.outboxId, occurredAt: this.now() });
      writeStarted = true;
      const result = await input.invoke(attempt.traceIdentity);
      const nativeSessionId = requiredIdentity(input.nativeSessionId(result), 'nativeSessionId');
      const providerGenerationId = input.acceptedProviderGenerationId?.(result) ?? input.providerGenerationId;
      this.db.durableTransactionSync(() => {
        input.mutateBusinessState?.(result);
        this.commandDeliveries.recordOutcomeInCurrentTransaction({
          outboxId: attempt.outboxId,
          outcome: 'accepted',
          providerId: 'codex',
          providerGenerationId,
          nativeSessionId,
          nativeTurnId: null,
          evidence: { source: 'codex_provider_command_application', operation: input.operation, traceIdentity: attempt.traceIdentity, resultIdentity: nativeSessionId },
          occurredAt: this.now(),
        });
      });
      return result;
    } catch (error) {
      this.recordFailure(attempt.outboxId, attempt.traceIdentity, input, error, writeStarted);
      throw error;
    }
  }

  async executeTurn<T>(input: ExecuteCodexTurnCommandInput<T>): Promise<T> {
    const attempt = this.prepare(input, 'provider_turn');
    if (attempt.state === 'accepted_replay') throw commandError('ZEUS_CODEX_PROVIDER_ACCEPTED_RECOVERY_REQUIRED', 'Codex Provider turn 已接纳，必须通过 turn 对账恢复，禁止重放。');
    let writeStarted = false;
    try {
      this.commandDeliveries.markProviderWriteStarted({ outboxId: attempt.outboxId, occurredAt: this.now() });
      writeStarted = true;
      const result = await input.invoke(attempt.traceIdentity);
      const nativeSessionId = requiredIdentity(input.nativeSessionId, 'nativeSessionId');
      const nativeTurnId = requiredIdentity(input.nativeTurnId(result), 'nativeTurnId');
      const providerGenerationId = input.acceptedProviderGenerationId?.(result) ?? input.providerGenerationId;
      this.db.durableTransactionSync(() => {
        input.mutateBusinessState?.(result);
        this.commandDeliveries.recordOutcomeInCurrentTransaction({
          outboxId: attempt.outboxId,
          outcome: 'accepted',
          providerId: 'codex',
          providerGenerationId,
          nativeSessionId,
          nativeTurnId,
          evidence: { source: 'codex_provider_command_application', operation: input.operation, traceIdentity: attempt.traceIdentity, resultIdentity: `${nativeSessionId}:${nativeTurnId}` },
          occurredAt: this.now(),
        });
      });
      return result;
    } catch (error) {
      this.recordFailure(attempt.outboxId, attempt.traceIdentity, input, error, writeStarted);
      throw error;
    }
  }

  private prepare(
    input: ExecuteCodexProviderCommandBase<unknown>,
    destinationKind: 'provider_session' | 'provider_turn',
  ): { state: 'prepared'; outboxId: string; traceIdentity: string | null } | { state: 'accepted_replay'; receipt: CommandDeliveryReceiptRecord } {
    const requestSha256 = sha256(canonicalJson(input.requestIdentity));
    const traceIdentity = input.traceIdentity === undefined ? currentDatabasePerformanceTraceId() : input.traceIdentity;
    const commandId = stableCommandId(input.operation, input.scope.kind, input.scope.id, input.commandKey);
    const freshEnvelope: CommandEnvelope<CodexProviderCommandPayload> = {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId,
      commandType: commandType(input.operation),
      actor: { kind: 'local_api', id: 'zeus-local-server' },
      scope: input.scope,
      expectedRevision: null,
      idempotencyKey: `codex:${input.operation}:${sha256(input.idempotencyKey)}`,
      issuedAt: input.issuedAt,
      traceIdentity,
      payload: { provider: 'codex', operation: input.operation, resourceId: input.resourceId, requestSha256 },
    };
    const existing = this.commandDeliveries.get(commandId);
    const envelope = existing ? parseStoredEnvelope(existing.inbox.envelopeJson, freshEnvelope) : freshEnvelope;
    try {
      const prepared = this.commandDeliveries.acceptAndPrepare({
        envelope,
        requestSha256,
        destinationKind,
        destinationId: destinationKind === 'provider_session' ? 'codex:session' : 'codex:turn',
        resourceId: input.resourceId,
        occurredAt: this.now(),
      });
      return { state: 'prepared', outboxId: prepared.outbox.id, traceIdentity: envelope.traceIdentity ?? null };
    } catch (error) {
      if (readErrorCode(error) !== 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED') throw error;
      const latest = this.commandDeliveries.get(commandId)?.attempts.at(-1);
      if (latest?.outcome !== 'accepted' || !latest.receipt || destinationKind !== 'provider_session') throw error;
      return { state: 'accepted_replay', receipt: latest.receipt };
    }
  }

  private recordFailure(outboxId: string, traceIdentity: string | null, input: ExecuteCodexProviderCommandBase<unknown>, error: unknown, writeStarted: boolean): void {
    const outcome = input.isExplicitRejection?.(error) === true ? 'explicitly_rejected' : writeStarted ? 'outcome_unknown_after_write' : 'failed_before_write';
    try {
      this.commandDeliveries.recordOutcome({
        outboxId,
        outcome,
        providerId: 'codex',
        providerGenerationId: input.providerGenerationId,
        evidence: { source: 'codex_provider_command_application', operation: input.operation, traceIdentity, result: outcome, error: serializeError(error) },
        occurredAt: this.now(),
      });
    } catch (receiptError) {
      if (readErrorCode(receiptError) !== 'ZEUS_COMMAND_DELIVERY_RECEIPT_CONFLICT') throw new AggregateError([error, receiptError], 'Codex Provider 操作与失败回执同时未能收口。');
    }
  }
}

function parseStoredEnvelope(serialized: string, expected: CommandEnvelope<CodexProviderCommandPayload>): CommandEnvelope<CodexProviderCommandPayload> {
  const parsed = parseCommandEnvelope<CodexProviderCommandPayload>(JSON.parse(serialized) as unknown);
  if (
    parsed.commandId !== expected.commandId ||
    parsed.commandType !== expected.commandType ||
    parsed.scope.kind !== expected.scope.kind ||
    parsed.scope.id !== expected.scope.id ||
    parsed.idempotencyKey !== expected.idempotencyKey ||
    parsed.payload.provider !== 'codex' ||
    parsed.payload.operation !== expected.payload.operation ||
    parsed.payload.resourceId !== expected.payload.resourceId ||
    parsed.payload.requestSha256 !== expected.payload.requestSha256
  ) {
    throw commandError('ZEUS_CODEX_PROVIDER_COMMAND_IDENTITY_CONFLICT', '既有 Codex Provider 命令与当前请求身份不一致，拒绝重放。');
  }
  return parsed;
}

function commandType(operation: CodexProviderCommandOperation): string {
  return `provider.codex.${operation.replaceAll('_', '.')}`;
}

function stableCommandId(operation: CodexProviderCommandOperation, scopeKind: string, scopeId: string, commandKey: string): string {
  return `command_codex_${operation}_${sha256(canonicalJson([scopeKind, scopeId, commandKey])).slice(0, 32)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? JSON.stringify(String(value)) : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requiredIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw commandError('ZEUS_CODEX_PROVIDER_IDENTITY_MISSING', `Codex Provider accepted 缺少 ${field}。`);
  return value;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { code: readErrorCode(error), name: error.name, message: error.message };
  return { code: null, name: typeof error, message: String(error) };
}

function readErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

function commandError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
