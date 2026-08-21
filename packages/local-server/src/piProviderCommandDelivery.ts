import { createHash } from 'node:crypto';
import { commandEnvelopeSchemaGeneration, parseCommandEnvelope, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { currentDatabasePerformanceTraceId, type CommandDeliveryRepository } from '@zeus/storage';

export type PiProviderCommandOperation = 'session_open' | 'run_start' | 'run_steer' | 'run_interrupt';

export interface PreparePiProviderCommandInput {
  operation: PiProviderCommandOperation;
  commandKey: string;
  scope: { kind: CommandScopeKind; id: string };
  idempotencyKey: string;
  issuedAt: string;
  resourceId: string;
  requestIdentity: unknown;
  providerGenerationId: string | null;
  traceIdentity?: string | null;
}

interface PiProviderCommandPayload extends Record<string, unknown> {
  provider: 'pi';
  operation: PiProviderCommandOperation;
  resourceId: string;
  requestSha256: string;
}

/**
 * Pi Provider 写边界的单次耐久尝试。
 *
 * session 与 run 使用不同 destination，避免把 SDK session 冒充 Worker generation，
 * 也避免把 interrupt/steer 合并进语义过粗的首轮派发回执。
 */
export class PiProviderCommandAttempt {
  private writeStarted = false;
  private settled = false;

  constructor(
    private readonly commandDeliveries: CommandDeliveryRepository,
    readonly operation: PiProviderCommandOperation,
    readonly commandId: string,
    readonly outboxId: string,
    readonly traceIdentity: string | null,
    private readonly providerGenerationId: string | null,
    private readonly now: () => string,
    private readonly redactSensitiveText: (value: string) => { text: string },
  ) {}

  markProviderWriteStarted(): void {
    if (this.writeStarted) return;
    this.commandDeliveries.markProviderWriteStarted({ outboxId: this.outboxId, occurredAt: this.now() });
    this.writeStarted = true;
  }

  recordSessionAcceptedAtomically(
    input: { nativeSessionId: string; runtimeInstanceId: string; nativeSessionPath: string | null; evidence?: unknown },
    boundary: { durableTransactionSync(operation: () => void): void; projectNativeSession(): void },
  ): void {
    this.assertOpen('原子记录 session accepted');
    boundary.durableTransactionSync(() => {
      boundary.projectNativeSession();
      this.commandDeliveries.recordOutcomeInCurrentTransaction({
        outboxId: this.outboxId,
        outcome: 'accepted',
        providerId: 'pi',
        providerGenerationId: input.runtimeInstanceId,
        nativeSessionId: input.nativeSessionId,
        nativeTurnId: null,
        evidence: input.evidence ?? {
          source: 'pi_provider_command_application',
          operation: this.operation,
          traceIdentity: this.traceIdentity,
          nativeSessionPathPresent: input.nativeSessionPath !== null,
        },
        occurredAt: this.now(),
      });
    });
    // 只有 COMMIT 成功后才能在进程内标为 settled；注入回滚后仍必须能记录 unknown。
    this.settled = true;
  }

  recordTurnAccepted(input: { nativeSessionId: string; nativeTurnId: string; acceptedAt: string; evidence?: unknown }): void {
    this.assertOpen('记录 turn accepted');
    this.commandDeliveries.recordOutcome({
      outboxId: this.outboxId,
      outcome: 'accepted',
      providerId: 'pi',
      providerGenerationId: this.providerGenerationId,
      nativeSessionId: input.nativeSessionId,
      nativeTurnId: input.nativeTurnId,
      evidence: input.evidence ?? { source: 'pi_provider_command_application', operation: this.operation, traceIdentity: this.traceIdentity },
      occurredAt: input.acceptedAt,
    });
    this.settled = true;
  }

  recordTurnAcceptedAtomically(input: { nativeSessionId: string; nativeTurnId: string; acceptedAt: string; evidence?: unknown }, boundary: { durableTransactionSync(operation: () => void): void; projectTurn(): void }): void {
    this.assertOpen('原子记录 turn accepted');
    boundary.durableTransactionSync(() => {
      this.commandDeliveries.recordOutcomeInCurrentTransaction({
        outboxId: this.outboxId,
        outcome: 'accepted',
        providerId: 'pi',
        providerGenerationId: this.providerGenerationId,
        nativeSessionId: input.nativeSessionId,
        nativeTurnId: input.nativeTurnId,
        evidence: input.evidence ?? { source: 'pi_provider_command_application', operation: this.operation, traceIdentity: this.traceIdentity },
        occurredAt: input.acceptedAt,
      });
      boundary.projectTurn();
    });
    // 与 session accepted 相同：只有 durableTransactionSync 成功返回才能阻止后续 unknown 收口。
    this.settled = true;
  }

  recordFailure(error: unknown, input: { explicitlyRejected: boolean; nativeSessionId?: string | null; nativeTurnId?: string | null }): void {
    if (this.settled) return;
    const outcome = input.explicitlyRejected ? 'explicitly_rejected' : this.writeStarted ? 'outcome_unknown_after_write' : 'failed_before_write';
    this.commandDeliveries.recordOutcome({
      outboxId: this.outboxId,
      outcome,
      providerId: 'pi',
      providerGenerationId: this.providerGenerationId,
      nativeSessionId: input.nativeSessionId ?? null,
      nativeTurnId: input.nativeTurnId ?? null,
      evidence: {
        source: 'pi_provider_command_application',
        operation: this.operation,
        traceIdentity: this.traceIdentity,
        result: outcome,
        error: serializeError(error, this.redactSensitiveText),
      },
      occurredAt: this.now(),
    });
    this.settled = true;
  }

  private assertOpen(action: string): void {
    if (this.settled) throw commandError('ZEUS_PI_PROVIDER_COMMAND_ALREADY_SETTLED', `Pi Provider 命令已收口，不能再次${action}。`);
  }
}

export class PiProviderCommandApplicationService {
  constructor(
    private readonly commandDeliveries: CommandDeliveryRepository,
    private readonly now: () => string,
    private readonly redactSensitiveText: (value: string) => { text: string },
  ) {}

  prepare(input: PreparePiProviderCommandInput): PiProviderCommandAttempt {
    const requestSha256 = sha256(canonicalJson(input.requestIdentity));
    const traceIdentity = input.traceIdentity === undefined ? currentDatabasePerformanceTraceId() : input.traceIdentity;
    const commandId = stableCommandId(input.operation, input.scope.kind, input.scope.id, input.commandKey);
    const freshEnvelope: CommandEnvelope<PiProviderCommandPayload> = {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId,
      commandType: commandType(input.operation),
      actor: { kind: 'local_api', id: 'zeus-local-server' },
      scope: input.scope,
      expectedRevision: null,
      idempotencyKey: stableIdempotencyKey(input.operation, input.idempotencyKey),
      issuedAt: input.issuedAt,
      traceIdentity,
      payload: {
        provider: 'pi',
        operation: input.operation,
        resourceId: input.resourceId,
        requestSha256,
      },
    };
    const existing = this.commandDeliveries.get(commandId);
    const envelope = existing ? parseStoredEnvelope(existing.inbox.envelopeJson, freshEnvelope) : freshEnvelope;
    const prepared = this.commandDeliveries.acceptAndPrepare({
      envelope,
      requestSha256,
      destinationKind: input.operation === 'session_open' ? 'provider_session' : 'provider_turn',
      destinationId: input.operation === 'session_open' ? 'pi:session' : 'pi:turn',
      resourceId: input.resourceId,
      occurredAt: this.now(),
    });
    return new PiProviderCommandAttempt(this.commandDeliveries, input.operation, commandId, prepared.outbox.id, envelope.traceIdentity ?? null, input.providerGenerationId, this.now, this.redactSensitiveText);
  }
}

function parseStoredEnvelope(serialized: string, expected: CommandEnvelope<PiProviderCommandPayload>): CommandEnvelope<PiProviderCommandPayload> {
  const parsed = parseCommandEnvelope<PiProviderCommandPayload>(JSON.parse(serialized) as unknown);
  if (
    parsed.commandId !== expected.commandId ||
    parsed.commandType !== expected.commandType ||
    parsed.scope.kind !== expected.scope.kind ||
    parsed.scope.id !== expected.scope.id ||
    parsed.idempotencyKey !== expected.idempotencyKey ||
    parsed.payload.provider !== 'pi' ||
    parsed.payload.operation !== expected.payload.operation ||
    parsed.payload.resourceId !== expected.payload.resourceId ||
    parsed.payload.requestSha256 !== expected.payload.requestSha256
  ) {
    throw commandError('ZEUS_PI_PROVIDER_COMMAND_IDENTITY_CONFLICT', '既有 Pi Provider 命令与当前请求身份不一致，拒绝重放。');
  }
  return parsed;
}

function commandType(operation: PiProviderCommandOperation): string {
  switch (operation) {
    case 'session_open':
      return 'provider.pi.session.open';
    case 'run_start':
      return 'provider.pi.run.start';
    case 'run_steer':
      return 'provider.pi.run.steer';
    case 'run_interrupt':
      return 'provider.pi.run.interrupt';
  }
}

function stableCommandId(operation: PiProviderCommandOperation, scopeKind: string, scopeId: string, commandKey: string): string {
  return `command_pi_${operation}_${sha256(canonicalJson([scopeKind, scopeId, commandKey])).slice(0, 32)}`;
}

function stableIdempotencyKey(operation: PiProviderCommandOperation, value: string): string {
  return `pi:${operation}:${sha256(value)}`;
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

function serializeError(error: unknown, redactSensitiveText: (value: string) => { text: string }): Record<string, unknown> {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : error.name;
    return { code: boundedUtf8(code, 256), name: boundedUtf8(error.name, 256), message: boundedErrorMessage(error.message, redactSensitiveText) };
  }
  return { code: null, name: boundedUtf8(typeof error, 256), message: boundedErrorMessage(String(error), redactSensitiveText) };
}

function boundedErrorMessage(value: string, redactSensitiveText: (value: string) => { text: string }): string {
  return boundedUtf8(redactSensitiveText(value).text, 2 * 1024);
}

function boundedUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maximumBytes) return value;
  return `${encoded
    .subarray(0, Math.max(0, maximumBytes - 3))
    .toString('utf8')
    .replace(/\uFFFD$/u, '')}...`;
}

function commandError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
